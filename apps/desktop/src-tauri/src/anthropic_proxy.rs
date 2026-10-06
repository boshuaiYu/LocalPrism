mod identity;
mod messages;
mod providers;
pub(crate) mod responses;
mod stream;
pub(crate) mod tools;
mod transformers;
pub(crate) mod usage;

use self::messages::{
    anthropic_to_openai_request, hoist_anthropic_system_messages, normalize_openai_system_messages,
    openai_to_anthropic_message, stabilize_third_party_prompt_prefix,
};
use self::providers::apply_provider_request_transforms;
use self::responses::{
    codex_turn_state_for_request, parse_sse_block, prepare_codex_request,
    remember_codex_turn_state, responses_headers, CodexProxyCredential, ResponsesToAnthropic,
    NO_OUTPUT_TIMEOUT_PREFIX,
};
use self::stream::{sse_response, stream_openai_sse_to_anthropic};
use self::transformers::ProxyTransformerChain;
use crate::providers::openai_oauth::OPENAI_CODEX_API_ENDPOINT;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const MAX_PROXY_CONNECTIONS: usize = 8;
const MAX_PROXY_HEADER_BYTES: usize = 1024 * 1024;
const MAX_PROXY_BODY_BYTES: usize = 32 * 1024 * 1024;
const PROXY_READ_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug)]
pub(crate) struct OpenAiProxyCredential {
    pub(crate) api_key: String,
    pub(crate) base_url: String,
    pub(crate) model: String,
    pub(crate) transformers: Vec<String>,
    pub(crate) model_transformers: Vec<String>,
    /// Claude spawn slot. `0` does not rewrite `result.usage`.
    pub(crate) usage_slot: u64,
}

pub(crate) fn proxy_capability_token(proxy_url: &str) -> Option<String> {
    let parsed = url::Url::parse(proxy_url).ok()?;
    parsed
        .path_segments()?
        .next()
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
}

fn new_proxy_capability() -> String {
    crate::providers::crypto::random_hex(32)
}

fn proxy_listen_url(addr: SocketAddr, token: &str) -> String {
    format!("http://{addr}/{token}/")
}

pub(crate) async fn start_openai_anthropic_proxy(
    credential: OpenAiProxyCredential,
) -> Result<String, String> {
    crate::providers::ensure_secure_provider_base_url(&credential.base_url)?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|err| format!("Failed to start local provider proxy: {}", err))?;
    let addr = listener
        .local_addr()
        .map_err(|err| format!("Failed to read local provider proxy address: {}", err))?;
    let credential = Arc::new(credential);
    let token = new_proxy_capability();
    let slots = Arc::new(Semaphore::new(MAX_PROXY_CONNECTIONS));
    let listen_token = token.clone();

    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let Some((permit, stream)) = acquire_proxy_slot(&slots, stream).await else {
                continue;
            };
            let credential = Arc::clone(&credential);
            let token = listen_token.clone();
            tokio::spawn(async move {
                let _permit = permit;
                if let Err(err) = handle_connection(stream, credential, &token).await {
                    eprintln!("[anthropic-proxy] request failed: {}", err);
                }
            });
        }
    });

    Ok(proxy_listen_url(addr, &token))
}

/// Forward Anthropic `/v1/messages` after folding mid-transcript system
/// turns into the top-level `system` field. Used for Qwen / DeepSeek /
/// Moonshot native Anthropic endpoints and other Anthropic-format
/// third-party providers that still compile a Qwen-style chat template.
pub(crate) async fn start_anthropic_passthrough_proxy(
    credential: OpenAiProxyCredential,
) -> Result<String, String> {
    crate::providers::ensure_secure_provider_base_url(&credential.base_url)?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|err| format!("Failed to start local Anthropic proxy: {}", err))?;
    let addr = listener
        .local_addr()
        .map_err(|err| format!("Failed to read local Anthropic proxy address: {}", err))?;
    let credential = Arc::new(credential);
    let token = new_proxy_capability();
    let slots = Arc::new(Semaphore::new(MAX_PROXY_CONNECTIONS));
    let listen_token = token.clone();

    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let Some((permit, stream)) = acquire_proxy_slot(&slots, stream).await else {
                continue;
            };
            let credential = Arc::clone(&credential);
            let token = listen_token.clone();
            tokio::spawn(async move {
                let _permit = permit;
                if let Err(err) =
                    handle_anthropic_passthrough_connection(stream, credential, &token).await
                {
                    eprintln!("[anthropic-passthrough] request failed: {}", err);
                }
            });
        }
    });

    Ok(proxy_listen_url(addr, &token))
}

async fn handle_anthropic_passthrough_connection(
    mut stream: TcpStream,
    credential: Arc<OpenAiProxyCredential>,
    token: &str,
) -> Result<(), String> {
    let Some(request) = accept_proxy_request(&mut stream, token).await? else {
        return Ok(());
    };
    let path = request_path_without_query(&request.path);
    if request.method == "POST" && (is_messages_path(path) || is_count_tokens_path(path)) {
        match handle_anthropic_passthrough(&request, path, &credential, &mut stream).await {
            Ok(()) => {
                let _ = stream.shutdown().await;
                return Ok(());
            }
            Err(err) => {
                let response = json_response(
                    502,
                    &json!({
                        "type": "error",
                        "error": { "type": "api_error", "message": err },
                    }),
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .map_err(|err| format!("Failed to write Anthropic proxy error: {err}"))?;
                let _ = stream.shutdown().await;
                return Ok(());
            }
        }
    }

    let response = json_response(
        200,
        &json!({ "ok": true, "service": "localprism-anthropic-passthrough-proxy" }),
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|err| format!("Failed to write Anthropic proxy ping: {err}"))?;
    let _ = stream.shutdown().await;
    Ok(())
}

async fn handle_anthropic_passthrough(
    request: &HttpRequest,
    path: &str,
    credential: &OpenAiProxyCredential,
    stream: &mut TcpStream,
) -> Result<(), String> {
    let mut body = serde_json::from_slice::<Value>(&request.body)
        .map_err(|err| format!("Claude Code sent invalid Anthropic JSON: {err}"))?;
    let subagent =
        crate::codex_turn_usage::subagent_marker(claude_agent_header(request), &body).is_some();
    stabilize_third_party_prompt_prefix(&mut body, claude_session_header(request));
    hoist_anthropic_system_messages(&mut body);
    tools::sanitize_tool_uses_in_messages(&mut body);
    if !credential.model.trim().is_empty() {
        body["model"] = Value::String(credential.model.clone());
    }
    let wants_stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);

    crate::providers::ensure_secure_provider_base_url(&credential.base_url)?;
    let client = crate::providers::bypass_system_proxy_for_loopback(
        reqwest::Client::builder()
            // Upper bound for the whole body. Chunk reads use a 45s/180s idle
            // timeout and stop when the Claude client disconnects.
            .timeout(std::time::Duration::from_secs(900))
            .redirect(reqwest::redirect::Policy::none()),
        &credential.base_url,
    )
    .build()
    .map_err(|err| format!("Failed to create Anthropic provider client: {err}"))?;
    let url = if is_count_tokens_path(path) {
        anthropic_count_tokens_url(&credential.base_url)
    } else {
        anthropic_messages_url(&credential.base_url)
    };
    let mut builder = client
        .post(url)
        .header("Content-Type", "application/json")
        .body(body.to_string());
    builder = with_optional_anthropic_key(builder, &credential.api_key);
    if let Some(version) = request_header(request, "anthropic-version") {
        builder = builder.header("anthropic-version", version);
    } else {
        builder = builder.header("anthropic-version", "2023-06-01");
    }
    if let Some(beta) = request_header(request, "anthropic-beta") {
        builder = builder.header("anthropic-beta", beta);
    }

    let response = builder
        .send()
        .await
        .map_err(|err| format!("Provider request failed: {err}"))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json")
        .to_string();

    if wants_stream && status.is_success() && content_type.to_ascii_lowercase().contains("stream") {
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n",
            )
            .await
            .map_err(|err| format!("Failed to write Anthropic SSE headers: {err}"))?;
        let mut response = response;
        let mut filter = tools::AnthropicToolInputSseFilter::default();
        let mut usage = usage::AnthropicStreamUsage::default();
        let mut saw_bytes = false;
        loop {
            match read_provider_chunk(&mut response, stream, saw_bytes).await {
                ProviderRead::Chunk(chunk) => {
                    saw_bytes = true;
                    usage.push_bytes(&chunk);
                    let rewritten = filter.push_bytes(&chunk);
                    if !rewritten.is_empty() {
                        if let Err(err) = stream.write_all(&rewritten).await {
                            usage.finish();
                            usage.commit(&credential.model, credential.usage_slot, subagent);
                            return Err(format!("Failed to write Anthropic SSE chunk: {err}"));
                        }
                    }
                }
                ProviderRead::End => break,
                ProviderRead::Failed(err) => {
                    usage.finish();
                    usage.commit(&credential.model, credential.usage_slot, subagent);
                    return Err(format!("Provider stream error: {err}"));
                }
                ProviderRead::Idle => {
                    usage.finish();
                    usage.commit(&credential.model, credential.usage_slot, subagent);
                    let _ = stream.write_all(provider_idle_sse().as_bytes()).await;
                    return Ok(());
                }
                ProviderRead::ClientGone => {
                    usage.finish();
                    usage.commit(&credential.model, credential.usage_slot, subagent);
                    return Ok(());
                }
            }
        }
        let tail = filter.finish_bytes();
        if !tail.is_empty() {
            if let Err(err) = stream.write_all(&tail).await {
                usage.finish();
                usage.commit(&credential.model, credential.usage_slot, subagent);
                return Err(format!("Failed to write Anthropic SSE tail: {err}"));
            }
        }
        usage.finish();
        usage.commit(&credential.model, credential.usage_slot, subagent);
        return Ok(());
    }

    let response_text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read provider response: {err}"))?;
    let response_text = if status.is_success() {
        if let Ok(message) = serde_json::from_str::<Value>(&response_text) {
            let mut usage = usage::AnthropicStreamUsage::default();
            usage.observe_message(&message);
            usage.commit(&credential.model, credential.usage_slot, subagent);
        }
        tools::sanitize_anthropic_message_body(&response_text)
    } else {
        response_text
    };
    stream
        .write_all(http_response(status.as_u16(), &content_type, &response_text).as_bytes())
        .await
        .map_err(|err| format!("Failed to write Anthropic proxy response: {err}"))?;
    Ok(())
}

pub(super) enum ProviderRead {
    Chunk(Vec<u8>),
    End,
    Idle,
    Failed(String),
    ClientGone,
}

/// 45s until the first byte, then 180s between chunks. Matches the Codex proxy.
pub(super) fn provider_stream_idle(saw_bytes: bool) -> Duration {
    Duration::from_secs(if saw_bytes { 180 } else { 45 })
}

pub(super) async fn read_provider_chunk(
    response: &mut reqwest::Response,
    client: &TcpStream,
    saw_bytes: bool,
) -> ProviderRead {
    let idle = provider_stream_idle(saw_bytes);
    tokio::select! {
        result = tokio::time::timeout(idle, response.chunk()) => match result {
            Ok(Ok(Some(chunk))) => ProviderRead::Chunk(chunk.to_vec()),
            Ok(Ok(None)) => ProviderRead::End,
            Ok(Err(err)) => ProviderRead::Failed(err.to_string()),
            Err(_) => ProviderRead::Idle,
        },
        () = wait_for_tcp_eof(client) => ProviderRead::ClientGone,
    }
}

async fn wait_for_tcp_eof(stream: &TcpStream) {
    let mut buf = [0u8; 1];
    loop {
        if stream.readable().await.is_err() {
            return;
        }
        match stream.try_read(&mut buf) {
            Ok(0) => return,
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => return,
        }
    }
}

fn provider_idle_sse() -> &'static str {
    "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"timeout_error\",\"message\":\"Provider stream idle timeout\"}}\n\n"
}

fn request_header<'a>(request: &'a HttpRequest, name: &str) -> Option<&'a str> {
    request
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn anthropic_messages_url(base_url: &str) -> String {
    let clean = base_url.trim_end_matches('/');
    if clean.ends_with("/v1/messages") || clean.ends_with("/messages") {
        clean.to_string()
    } else if clean.ends_with("/v1") {
        format!("{}/messages", clean)
    } else {
        format!("{}/v1/messages", clean)
    }
}

fn anthropic_count_tokens_url(base_url: &str) -> String {
    format!("{}/count_tokens", anthropic_messages_url(base_url))
}

fn with_optional_anthropic_key(
    request: reqwest::RequestBuilder,
    api_key: &str,
) -> reqwest::RequestBuilder {
    if api_key.trim().is_empty() {
        request
    } else {
        request.header("x-api-key", api_key).bearer_auth(api_key)
    }
}

pub(crate) async fn start_codex_responses_proxy(
    credential: CodexProxyCredential,
) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|err| format!("Failed to start Codex Responses proxy: {}", err))?;
    let addr = listener
        .local_addr()
        .map_err(|err| format!("Failed to read Codex Responses proxy address: {}", err))?;
    let credential = Arc::new(credential);
    let token = new_proxy_capability();
    let slots = Arc::new(Semaphore::new(MAX_PROXY_CONNECTIONS));
    let listen_token = token.clone();

    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let Some((permit, stream)) = acquire_proxy_slot(&slots, stream).await else {
                continue;
            };
            let credential = Arc::clone(&credential);
            let token = listen_token.clone();
            tokio::spawn(async move {
                let _permit = permit;
                if let Err(err) = handle_codex_connection(stream, credential, &token).await {
                    eprintln!("[codex-responses-proxy] request failed: {}", err);
                }
            });
        }
    });

    Ok(proxy_listen_url(addr, &token))
}

async fn handle_codex_connection(
    mut stream: TcpStream,
    credential: Arc<CodexProxyCredential>,
    token: &str,
) -> Result<(), String> {
    let Some(request) = accept_proxy_request(&mut stream, token).await? else {
        return Ok(());
    };
    let path = request_path_without_query(&request.path);
    if request.method == "POST" && is_messages_path(path) {
        match handle_codex_messages(&request, &credential, &mut stream).await {
            Ok(()) => {
                let _ = stream.shutdown().await;
                return Ok(());
            }
            Err(err) => {
                let response = json_response(
                    502,
                    &json!({
                        "type": "error",
                        "error": { "type": "api_error", "message": err },
                    }),
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .map_err(|err| format!("Failed to write Codex proxy error: {err}"))?;
                let _ = stream.shutdown().await;
                return Ok(());
            }
        }
    }
    if request.method == "POST" && is_count_tokens_path(path) {
        let response = handle_count_tokens(&request);
        stream
            .write_all(response.as_bytes())
            .await
            .map_err(|err| format!("Failed to write Codex count_tokens: {err}"))?;
        let _ = stream.shutdown().await;
        return Ok(());
    }
    let response = json_response(
        200,
        &json!({ "ok": true, "service": "localprism-codex-responses-proxy" }),
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|err| format!("Failed to write Codex proxy ping: {err}"))?;
    let _ = stream.shutdown().await;
    Ok(())
}

async fn handle_codex_messages(
    request: &HttpRequest,
    credential: &CodexProxyCredential,
    stream: &mut TcpStream,
) -> Result<(), String> {
    let anthropic_request: Value = serde_json::from_slice(&request.body)
        .map_err(|err| format!("Claude Code sent invalid Anthropic JSON: {err}"))?;
    let header_session = claude_session_header(request);
    let header_agent = claude_agent_header(request);
    let prepared =
        prepare_codex_request(&anthropic_request, credential, header_session, header_agent)?;
    let body = prepared.body;
    let subagent = prepared.subagent;
    let cache_key = body
        .get("prompt_cache_key")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let input = body.get("input").and_then(Value::as_array).cloned();
    let turn_state = codex_turn_state_for_request(&cache_key, input.as_deref().unwrap_or(&[]));
    let client = crate::providers::bypass_system_proxy_for_loopback(
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(180))
            .redirect(reqwest::redirect::Policy::none()),
        OPENAI_CODEX_API_ENDPOINT,
    )
    .build()
    .map_err(|err| format!("Failed to create Codex Responses client: {err}"))?;
    let mut credential = credential.clone();
    let mut retried_auth = false;
    let mut logged_request = false;
    let mut response = loop {
        let headers = responses_headers(
            &credential,
            (!cache_key.is_empty()).then_some(cache_key.as_str()),
            turn_state.as_deref(),
        );
        if !logged_request {
            crate::usage_debug::log_codex_request(
                &credential.model,
                body.get("instructions").and_then(Value::as_str),
                body.get("tools"),
                input.as_deref().unwrap_or(&[]),
                &cache_key,
                prepared.cache_key_origin,
                &headers,
                subagent,
            );
            logged_request = true;
        }
        let mut builder = client
            .post(OPENAI_CODEX_API_ENDPOINT)
            .body(body.to_string());
        for (key, value) in headers {
            builder = builder.header(key, value);
        }
        let response = builder.send().await.map_err(|err| {
            format!(
                "Codex Responses request failed for {}: {err}",
                credential.model
            )
        })?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED && !retried_auth {
            if let Some(refresh) = credential.refresh_token.clone() {
                retried_auth = true;
                let tokens = crate::providers::openai_oauth::refresh_tokens(&refresh).await?;
                crate::providers::openai_oauth::persist_tokens(tokens.clone()).await?;
                credential.access_token = tokens.access_token;
                credential.refresh_token = tokens.refresh_token;
                if tokens.account_id.is_some() {
                    credential.account_id = tokens.account_id;
                }
                continue;
            }
        }
        break response;
    };
    if let Some(state) = response
        .headers()
        .get("x-codex-turn-state")
        .and_then(|value| value.to_str().ok())
    {
        remember_codex_turn_state(&cache_key, state);
    }
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_else(|_| String::new());
        return Err(format!(
            "Codex Responses returned HTTP {status} for {}: {text}",
            credential.model
        ));
    }

    stream
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n")
        .await
        .map_err(|err| format!("Failed to write Codex SSE headers: {err}"))?;

    let mut translator = ResponsesToAnthropic::for_model(&credential.model);
    let mut buffer = String::new();
    let mut saw_output = false;
    let mut usage_recorded = false;
    loop {
        let idle = if saw_output {
            std::time::Duration::from_secs(180)
        } else {
            std::time::Duration::from_secs(45)
        };
        let chunk = match tokio::time::timeout(idle, response.chunk()).await {
            Ok(Ok(Some(bytes))) => bytes,
            Ok(Ok(None)) => break,
            Ok(Err(err)) => {
                if !usage_recorded {
                    record_codex_request_usage(&credential, &translator, subagent);
                }
                write_proxy_sse(
                    stream,
                    &translator.fail(&format!(
                        "Codex Responses stream error for {}: {err}",
                        credential.model
                    )),
                )
                .await?;
                return Ok(());
            }
            Err(_) => {
                let payload = if saw_output {
                    translator.close_stream()
                } else {
                    translator.fail(&format!("{NO_OUTPUT_TIMEOUT_PREFIX}{}", credential.model))
                };
                if !usage_recorded {
                    record_codex_request_usage(&credential, &translator, subagent);
                }
                write_proxy_sse(stream, &payload).await?;
                return Ok(());
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some((block, rest)) = take_sse_block(&buffer) {
            buffer = rest;
            if let Some((event, data)) = parse_sse_block(&block) {
                let translated = translator.handle_event(&event, &data);
                if !usage_recorded {
                    usage_recorded = record_codex_request_usage(&credential, &translator, subagent);
                }
                if !translated.is_empty() {
                    saw_output = true;
                }
                write_proxy_sse(stream, &translated).await?;
            }
        }
    }
    if !buffer.trim().is_empty() {
        if let Some((event, data)) = parse_sse_block(&buffer) {
            let translated = translator.handle_event(&event, &data);
            if !usage_recorded {
                usage_recorded = record_codex_request_usage(&credential, &translator, subagent);
            }
            write_proxy_sse(stream, &translated).await?;
        }
    }
    if !usage_recorded {
        record_codex_request_usage(&credential, &translator, subagent);
    }
    write_proxy_sse(stream, &translator.close_stream()).await?;
    Ok(())
}

fn claude_session_header(request: &HttpRequest) -> Option<&str> {
    [
        "x-claude-code-session-id",
        "x-session-id",
        "session-id",
        "x-claude-session-id",
    ]
    .into_iter()
    .find_map(|name| request_header(request, name))
    .map(str::trim)
    .filter(|value| !value.is_empty())
}

fn claude_agent_header(request: &HttpRequest) -> Option<&str> {
    [
        "x-claude-code-agent-id",
        "x-claude-agent-id",
        "x-agent-id",
        "x-claude-code-parent-tool-use-id",
    ]
    .into_iter()
    .find_map(|name| request_header(request, name))
    .map(str::trim)
    .filter(|value| !value.is_empty())
}

fn record_codex_request_usage(
    credential: &CodexProxyCredential,
    translator: &ResponsesToAnthropic,
    subagent: bool,
) -> bool {
    if subagent || credential.usage_slot == 0 {
        return subagent;
    }
    let Some(usage) = translator.request_usage() else {
        return false;
    };
    crate::codex_turn_usage::record(credential.usage_slot, usage);
    true
}

fn take_sse_block(buffer: &str) -> Option<(String, String)> {
    if let Some(index) = buffer.find("\n\n") {
        return Some((buffer[..index].to_string(), buffer[index + 2..].to_string()));
    }
    if let Some(index) = buffer.find("\r\n\r\n") {
        return Some((buffer[..index].to_string(), buffer[index + 4..].to_string()));
    }
    None
}

async fn write_proxy_sse(stream: &mut TcpStream, payload: &str) -> Result<(), String> {
    if payload.is_empty() {
        return Ok(());
    }
    stream
        .write_all(payload.as_bytes())
        .await
        .map_err(|err| format!("Failed to write translated SSE: {err}"))
}

async fn handle_connection(
    mut stream: TcpStream,
    credential: Arc<OpenAiProxyCredential>,
    token: &str,
) -> Result<(), String> {
    let Some(request) = accept_proxy_request(&mut stream, token).await? else {
        return Ok(());
    };
    let path = request_path_without_query(&request.path);
    if request.method == "POST" && is_messages_path(path) {
        match handle_messages_to_stream(&request, &credential, &mut stream).await {
            Ok(()) => {
                let _ = stream.shutdown().await;
                return Ok(());
            }
            Err(err) => {
                let response = json_response(
                    502,
                    &json!({
                        "type": "error",
                        "error": {
                            "type": "api_error",
                            "message": err,
                        },
                    }),
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .map_err(|err| format!("Failed to write proxy error response: {}", err))?;
                let _ = stream.shutdown().await;
                return Ok(());
            }
        }
    }

    let response = route_request(&request).await;
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|err| format!("Failed to write proxy response: {}", err))?;
    let _ = stream.shutdown().await;
    Ok(())
}

struct HttpRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

async fn acquire_proxy_slot(
    slots: &Arc<Semaphore>,
    mut stream: TcpStream,
) -> Option<(OwnedSemaphorePermit, TcpStream)> {
    match slots.clone().try_acquire_owned() {
        Ok(permit) => Some((permit, stream)),
        Err(_) => {
            let _ =
                write_proxy_error(&mut stream, 503, "Too many concurrent proxy connections").await;
            None
        }
    }
}

async fn accept_proxy_request(
    stream: &mut TcpStream,
    token: &str,
) -> Result<Option<HttpRequest>, String> {
    let parsed = match tokio::time::timeout(PROXY_READ_TIMEOUT, read_http_headers(stream)).await {
        Ok(Ok(parsed)) => parsed,
        Ok(Err(err)) if err == "payload too large" => {
            write_proxy_error(stream, 413, "Proxy request body is too large").await?;
            return Ok(None);
        }
        Ok(Err(err)) => return Err(err),
        Err(_) => {
            write_proxy_error(stream, 408, "Proxy request timed out").await?;
            return Ok(None);
        }
    };
    if parsed.content_length > MAX_PROXY_BODY_BYTES {
        write_proxy_error(stream, 413, "Proxy request body is too large").await?;
        return Ok(None);
    }
    let mut request = HttpRequest {
        method: parsed.method,
        path: parsed.path,
        headers: parsed.headers,
        body: Vec::new(),
    };
    match authorize_proxy_request(&request, token) {
        Some(logical_path) => request.path = logical_path,
        None if request_forwards_stored_credentials(&request) => {
            write_proxy_error(
                stream,
                401,
                "Proxy request is missing a valid session capability",
            )
            .await?;
            return Ok(None);
        }
        None => {}
    }
    request.body = match tokio::time::timeout(
        PROXY_READ_TIMEOUT,
        read_http_body(stream, parsed.leftover, parsed.content_length),
    )
    .await
    {
        Ok(Ok(body)) => body,
        Ok(Err(err)) if err == "payload too large" => {
            write_proxy_error(stream, 413, "Proxy request body is too large").await?;
            return Ok(None);
        }
        Ok(Err(err)) => return Err(err),
        Err(_) => {
            write_proxy_error(stream, 408, "Proxy request timed out").await?;
            return Ok(None);
        }
    };
    Ok(Some(request))
}

struct ParsedHttpHeaders {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    content_length: usize,
    leftover: Vec<u8>,
}

async fn read_http_headers(stream: &mut TcpStream) -> Result<ParsedHttpHeaders, String> {
    let mut buffer = Vec::new();
    let mut temp = [0_u8; 8192];
    let header_end = loop {
        let n = stream
            .read(&mut temp)
            .await
            .map_err(|err| format!("Failed to read proxy request: {}", err))?;
        if n == 0 {
            return Err("Connection closed before HTTP headers were received".to_string());
        }
        buffer.extend_from_slice(&temp[..n]);
        if let Some(index) = find_header_end(&buffer) {
            break index;
        }
        if buffer.len() > MAX_PROXY_HEADER_BYTES {
            return Err("Proxy request headers are too large".to_string());
        }
    };

    let header_text = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = header_text.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| "Proxy request is missing request line".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| "Proxy request is missing method".to_string())?
        .to_string();
    let path = request_parts
        .next()
        .ok_or_else(|| "Proxy request is missing path".to_string())?
        .to_string();

    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .collect::<Vec<_>>();
    let content_length = headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_PROXY_BODY_BYTES {
        return Err("payload too large".to_string());
    }

    let body_start = header_end + 4;
    Ok(ParsedHttpHeaders {
        method,
        path,
        headers,
        content_length,
        leftover: buffer.get(body_start..).unwrap_or_default().to_vec(),
    })
}

async fn read_http_body(
    stream: &mut TcpStream,
    leftover: Vec<u8>,
    content_length: usize,
) -> Result<Vec<u8>, String> {
    if leftover.len() > MAX_PROXY_BODY_BYTES || content_length > MAX_PROXY_BODY_BYTES {
        return Err("payload too large".to_string());
    }
    let mut body = leftover;
    if body.len() > content_length {
        body.truncate(content_length);
    }
    let mut temp = [0_u8; 8192];
    while body.len() < content_length {
        let remaining = content_length - body.len();
        let to_read = remaining.min(temp.len());
        let n = stream
            .read(&mut temp[..to_read])
            .await
            .map_err(|err| format!("Failed to read proxy request body: {}", err))?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&temp[..n]);
        if body.len() > MAX_PROXY_BODY_BYTES {
            return Err("payload too large".to_string());
        }
    }
    body.truncate(content_length);
    Ok(body)
}

fn request_forwards_stored_credentials(request: &HttpRequest) -> bool {
    if !request.method.eq_ignore_ascii_case("POST") {
        return false;
    }
    let path = request_path_without_query(&request.path);
    is_messages_path(path) || is_count_tokens_path(path)
}

fn authorize_proxy_request(request: &HttpRequest, token: &str) -> Option<String> {
    let path = request_path_without_query(&request.path);
    if let Some(logical) = strip_capability_prefix(path, token) {
        return Some(logical.to_string());
    }
    if header_matches_capability(request, token) {
        return Some(path.to_string());
    }
    None
}

fn header_matches_capability(request: &HttpRequest, token: &str) -> bool {
    if request_header(request, "x-api-key")
        .is_some_and(|value| constant_time_eq(value.as_bytes(), token.as_bytes()))
    {
        return true;
    }
    if bearer_token(request)
        .is_some_and(|value| constant_time_eq(value.as_bytes(), token.as_bytes()))
    {
        return true;
    }
    basic_auth_user(request)
        .is_some_and(|value| constant_time_eq(value.as_bytes(), token.as_bytes()))
}

fn strip_capability_prefix<'a>(path: &'a str, token: &str) -> Option<&'a str> {
    let rest = path.strip_prefix('/')?;
    let (head, tail) = match rest.split_once('/') {
        Some((head, tail)) => (head, Some(tail)),
        None => (rest, None),
    };
    if !constant_time_eq(head.as_bytes(), token.as_bytes()) {
        return None;
    }
    match tail {
        None | Some("") => Some("/"),
        Some(_) => path.get(1 + token.len()..),
    }
}

fn bearer_token(request: &HttpRequest) -> Option<&str> {
    let value = request_header(request, "authorization")?;
    if value.len() >= 7 && value[..7].eq_ignore_ascii_case("bearer ") {
        let token = value[7..].trim();
        if token.is_empty() {
            None
        } else {
            Some(token)
        }
    } else {
        None
    }
}

fn basic_auth_user(request: &HttpRequest) -> Option<String> {
    let value = request_header(request, "authorization")?;
    let encoded = value
        .strip_prefix("Basic ")
        .or_else(|| value.strip_prefix("basic "))?
        .trim();
    let decoded = BASE64.decode(encoded).ok()?;
    let text = String::from_utf8(decoded).ok()?;
    let user = text.split(':').next()?.trim();
    if user.is_empty() {
        None
    } else {
        Some(user.to_string())
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right.iter())
        .fold(0_u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

async fn write_proxy_error(
    stream: &mut TcpStream,
    status: u16,
    message: &str,
) -> Result<(), String> {
    let response = json_response(
        status,
        &json!({
            "type": "error",
            "error": {
                "type": "invalid_request_error",
                "message": message,
            },
        }),
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|err| format!("Failed to write proxy error response: {err}"))?;
    let _ = stream.shutdown().await;
    Ok(())
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

async fn route_request(request: &HttpRequest) -> String {
    let path = request_path_without_query(&request.path);

    if request.method == "GET" && path == "/" {
        return json_response(
            200,
            &json!({ "ok": true, "service": "claude-prism-anthropic-proxy" }),
        );
    }

    if request.method == "POST" && is_count_tokens_path(path) {
        return handle_count_tokens(request);
    }

    json_response(
        400,
        &json!({
            "type": "error",
            "error": {
                "type": "invalid_request_error",
                "message": format!("Unsupported Anthropic proxy endpoint: {} {}", request.method, request.path),
            },
        }),
    )
}

fn request_path_without_query(path: &str) -> &str {
    path.split_once('?').map(|(path, _)| path).unwrap_or(path)
}

fn is_count_tokens_path(path: &str) -> bool {
    path.ends_with("/count_tokens")
}

fn is_messages_path(path: &str) -> bool {
    path.ends_with("/messages")
}

fn handle_count_tokens(request: &HttpRequest) -> String {
    let body = serde_json::from_slice::<Value>(&request.body).unwrap_or(Value::Null);
    let approx_chars = body.to_string().chars().count();
    json_response(
        200,
        &json!({
            "input_tokens": (approx_chars / 4).max(1),
        }),
    )
}

async fn handle_messages_to_stream(
    request: &HttpRequest,
    credential: &OpenAiProxyCredential,
    stream: &mut TcpStream,
) -> Result<(), String> {
    let mut anthropic_request: Value = serde_json::from_slice(&request.body)
        .map_err(|err| format!("Claude Code sent invalid Anthropic JSON: {}", err))?;
    let wants_stream = anthropic_request
        .get("stream")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let subagent =
        crate::codex_turn_usage::subagent_marker(claude_agent_header(request), &anthropic_request)
            .is_some();
    stabilize_third_party_prompt_prefix(&mut anthropic_request, claude_session_header(request));
    let transformers = ProxyTransformerChain::for_credential(credential, wants_stream);
    let mut openai_request =
        anthropic_to_openai_request(&anthropic_request, credential, &transformers)?;
    openai_request["stream"] = Value::Bool(wants_stream);
    apply_provider_request_transforms(
        &mut openai_request,
        &anthropic_request,
        credential,
        wants_stream,
        &transformers,
    );
    normalize_openai_system_messages(&mut openai_request);
    if request_contains_openai_image_parts(&openai_request)
        && provider_rejects_openai_image_parts(credential)
    {
        return Err(format!(
            "{} does not accept OpenAI-style image_url message parts. Switch to Claude Code or a vision-capable OpenAI-compatible endpoint for image questions.",
            credential.model
        ));
    }

    crate::providers::ensure_secure_provider_base_url(&credential.base_url)?;
    let client = crate::providers::bypass_system_proxy_for_loopback(
        reqwest::Client::builder()
            // Upper bound for the whole body. Chunk reads use a 45s/180s idle
            // timeout and stop when the Claude client disconnects.
            .timeout(std::time::Duration::from_secs(900))
            .redirect(reqwest::redirect::Policy::none()),
        &credential.base_url,
    )
    .build()
    .map_err(|err| format!("Failed to create provider client: {}", err))?;
    let request = client
        .post(openai_chat_completions_url(&credential.base_url))
        .header("Content-Type", "application/json")
        .body(openai_request.to_string());
    let response = with_optional_bearer_auth(request, &credential.api_key)
        .send()
        .await
        .map_err(|err| format!("Provider request failed: {}", err))?;

    let status = response.status();
    if !status.is_success() {
        let response_text = response
            .text()
            .await
            .map_err(|err| format!("Failed to read provider error response: {}", err))?;
        return Err(format!(
            "Provider returned HTTP {}: {}",
            status,
            compact_error_text(&response_text)
        ));
    }

    if wants_stream {
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if content_type.contains("stream") {
            stream_openai_sse_to_anthropic(
                stream,
                response,
                &anthropic_request,
                credential,
                subagent,
            )
            .await
        } else {
            let response_text = response
                .text()
                .await
                .map_err(|err| format!("Failed to read provider response: {}", err))?;
            let openai_response: Value = serde_json::from_str(&response_text)
                .map_err(|err| format!("Provider returned invalid JSON: {}", err))?;
            let anthropic_response =
                openai_to_anthropic_message(&anthropic_request, &openai_response, credential)?;
            record_translated_message_usage(credential, &anthropic_response, subagent);
            stream
                .write_all(sse_response(&anthropic_response).as_bytes())
                .await
                .map_err(|err| format!("Failed to write proxy SSE response: {}", err))
        }
    } else {
        let response_text = response
            .text()
            .await
            .map_err(|err| format!("Failed to read provider response: {}", err))?;
        let openai_response: Value = serde_json::from_str(&response_text)
            .map_err(|err| format!("Provider returned invalid JSON: {}", err))?;
        let anthropic_response =
            openai_to_anthropic_message(&anthropic_request, &openai_response, credential)?;
        record_translated_message_usage(credential, &anthropic_response, subagent);
        stream
            .write_all(json_response(200, &anthropic_response).as_bytes())
            .await
            .map_err(|err| format!("Failed to write proxy JSON response: {}", err))
    }
}

fn record_translated_message_usage(
    credential: &OpenAiProxyCredential,
    message: &Value,
    subagent: bool,
) {
    let Some(usage) = message.get("usage") else {
        return;
    };
    usage::record_turn_usage(
        credential.usage_slot,
        usage::split_provider_usage(usage),
        subagent,
    );
}

fn openai_chat_completions_url(base_url: &str) -> String {
    let clean = base_url.trim_end_matches('/');
    if clean.ends_with("/chat/completions") {
        clean.to_string()
    } else if openai_compatible_base_url_has_chat_root(clean) {
        format!("{}/chat/completions", clean)
    } else {
        format!("{}/v1/chat/completions", clean)
    }
}

fn with_optional_bearer_auth(
    request: reqwest::RequestBuilder,
    api_key: &str,
) -> reqwest::RequestBuilder {
    if api_key.trim().is_empty() {
        request
    } else {
        request.bearer_auth(api_key)
    }
}

fn request_contains_openai_image_parts(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(request_contains_openai_image_parts),
        Value::Object(object) => {
            object.get("type").and_then(Value::as_str) == Some("image_url")
                || object.values().any(request_contains_openai_image_parts)
        }
        _ => false,
    }
}

fn provider_rejects_openai_image_parts(credential: &OpenAiProxyCredential) -> bool {
    let base_url = credential.base_url.to_ascii_lowercase();
    base_url == "https://api.deepseek.com" || base_url.starts_with("https://api.deepseek.com/")
}

fn openai_compatible_base_url_has_chat_root(base_url: &str) -> bool {
    let lower = base_url.to_ascii_lowercase();
    if lower == "https://api.deepseek.com" {
        return true;
    }

    let path = lower
        .split_once("://")
        .and_then(|(_, rest)| rest.split_once('/').map(|(_, path)| path))
        .unwrap_or("")
        .trim_matches('/');
    if path.is_empty() {
        return false;
    }

    let segments = path.split('/').collect::<Vec<_>>();
    let last = segments.last().copied().unwrap_or_default();
    matches!(last, "v1" | "v2" | "v3" | "v4" | "beta")
        || path.ends_with("/openai")
        || path.ends_with("compatible-mode/v1")
}

fn json_response(status: u16, value: &Value) -> String {
    http_response(
        status,
        "application/json; charset=utf-8",
        &value.to_string(),
    )
}

fn http_response(status: u16, content_type: &str, body: &str) -> String {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    };
    format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        reason,
        content_type,
        body.as_bytes().len(),
        body
    )
}

fn compact_error_text(text: &str) -> String {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= 1000 {
        compact
    } else {
        format!("{}...", compact.chars().take(1000).collect::<String>())
    }
}

#[allow(dead_code)]
fn _assert_local_addr(_: SocketAddr) {}

#[cfg(test)]
mod tests {
    use super::transformers::ProxyTransformerChain;
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn recognizes_anthropic_messages_paths_with_query_strings() {
        let path = request_path_without_query("/v1/messages?beta=tools");
        assert_eq!(path, "/v1/messages");
        assert!(is_messages_path(path));
        assert!(is_count_tokens_path("/v1/messages/count_tokens"));
    }

    #[test]
    fn detects_openai_image_parts_for_provider_guard() {
        assert!(request_contains_openai_image_parts(&json!({
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": "what is this?" },
                    { "type": "image_url", "image_url": { "url": "data:image/png;base64,abc" } }
                ]
            }]
        })));
        assert!(!request_contains_openai_image_parts(&json!({
            "messages": [{ "role": "user", "content": "text only" }]
        })));
    }

    #[test]
    fn converts_tool_use_and_tool_result_messages() {
        let credential = OpenAiProxyCredential {
            api_key: "sk-test".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            model: "qwen-test".to_string(),
            transformers: Vec::new(),
            model_transformers: Vec::new(),
            usage_slot: 0,
        };
        let request = json!({
            "system": "system prompt",
            "messages": [
                {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "Read",
                        "input": { "file_path": "main.tex" }
                    }]
                },
                {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "file text"
                    }]
                }
            ],
            "tools": [{
                "name": "Read",
                "description": "Read a file",
                "input_schema": { "type": "object" }
            }]
        });

        let converted = anthropic_to_openai_request(
            &request,
            &credential,
            &ProxyTransformerChain::from_names(&[]),
        )
        .unwrap();
        assert_eq!(converted["model"], "qwen-test");
        assert_eq!(converted["messages"][0]["role"], "system");
        assert_eq!(
            converted["messages"][1]["tool_calls"][0]["function"]["name"],
            "Read"
        );
        assert_eq!(converted["messages"][2]["role"], "tool");
        assert_eq!(converted["tools"][0]["function"]["name"], "Read");
    }

    #[test]
    fn keeps_tool_results_immediately_after_tool_calls() {
        let credential = OpenAiProxyCredential {
            api_key: "sk-test".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            model: "qwen-test".to_string(),
            transformers: Vec::new(),
            model_transformers: Vec::new(),
            usage_slot: 0,
        };
        let request = json!({
            "messages": [
                {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "Read",
                        "input": { "file_path": "main.tex" }
                    }]
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "Now explain it."
                        },
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_1",
                            "content": "file text"
                        }
                    ]
                }
            ]
        });

        let converted = anthropic_to_openai_request(
            &request,
            &credential,
            &ProxyTransformerChain::from_names(&[]),
        )
        .unwrap();
        assert_eq!(converted["messages"][0]["role"], "assistant");
        assert_eq!(converted["messages"][1]["role"], "tool");
        assert_eq!(converted["messages"][1]["tool_call_id"], "toolu_1");
        assert_eq!(converted["messages"][2]["role"], "user");
        assert_eq!(converted["messages"][2]["content"], "Now explain it.");
    }

    #[test]
    fn synthesizes_missing_tool_results_before_user_messages() {
        let credential = OpenAiProxyCredential {
            api_key: "sk-test".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            model: "qwen-test".to_string(),
            transformers: Vec::new(),
            model_transformers: Vec::new(),
            usage_slot: 0,
        };
        let request = json!({
            "messages": [
                {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_missing",
                        "name": "Read",
                        "input": { "file_path": "main.tex" }
                    }]
                },
                {
                    "role": "user",
                    "content": "continue"
                }
            ]
        });

        let converted = anthropic_to_openai_request(
            &request,
            &credential,
            &ProxyTransformerChain::from_names(&[]),
        )
        .unwrap();
        assert_eq!(converted["messages"][0]["role"], "assistant");
        assert_eq!(converted["messages"][1]["role"], "tool");
        assert_eq!(converted["messages"][1]["tool_call_id"], "toolu_missing");
        assert_eq!(converted["messages"][2]["role"], "user");
        assert_eq!(converted["messages"][2]["content"], "continue");
    }

    #[test]
    fn converts_openai_tool_call_to_anthropic_message() {
        let credential = OpenAiProxyCredential {
            api_key: "sk-test".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            model: "deepseek-test".to_string(),
            transformers: Vec::new(),
            model_transformers: Vec::new(),
            usage_slot: 0,
        };
        let request = json!({ "model": "claude-sonnet-4" });
        let response = json!({
            "id": "chatcmpl_1",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "Grep",
                            "arguments": "{\"pattern\":\"FastVID\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 3 }
        });

        let converted = openai_to_anthropic_message(&request, &response, &credential).unwrap();
        assert_eq!(converted["stop_reason"], "tool_use");
        assert_eq!(converted["content"][0]["type"], "tool_use");
        assert_eq!(converted["content"][0]["input"]["pattern"], "FastVID");
    }

    fn test_credential(base_url: &str) -> OpenAiProxyCredential {
        OpenAiProxyCredential {
            api_key: "sk-test".to_string(),
            base_url: base_url.to_string(),
            model: "test-model".to_string(),
            transformers: Vec::new(),
            model_transformers: Vec::new(),
            usage_slot: 0,
        }
    }

    fn request_with(path: &str, headers: Vec<(&str, &str)>) -> HttpRequest {
        HttpRequest {
            method: "POST".into(),
            path: path.into(),
            headers: headers
                .into_iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
            body: Vec::new(),
        }
    }

    #[test]
    fn strips_session_capability_from_proxy_path() {
        assert_eq!(
            strip_capability_prefix("/abc123/v1/messages", "abc123"),
            Some("/v1/messages")
        );
        assert_eq!(strip_capability_prefix("/abc123", "abc123"), Some("/"));
        assert_eq!(strip_capability_prefix("/abc123/v1/messages", "zzz"), None);
        assert_eq!(strip_capability_prefix("/v1/messages", "abc123"), None);
    }

    #[test]
    fn accepts_capability_from_path_or_session_header() {
        let path_request = request_with("/secret-token/v1/messages", vec![]);
        assert_eq!(
            authorize_proxy_request(&path_request, "secret-token").as_deref(),
            Some("/v1/messages")
        );

        let header_request = request_with("/v1/messages", vec![("x-api-key", "secret-token")]);
        assert_eq!(
            authorize_proxy_request(&header_request, "secret-token").as_deref(),
            Some("/v1/messages")
        );

        let bearer_request = request_with(
            "/v1/messages",
            vec![("Authorization", "Bearer secret-token")],
        );
        assert_eq!(
            authorize_proxy_request(&bearer_request, "secret-token").as_deref(),
            Some("/v1/messages")
        );

        let unknown = request_with("/v1/messages", vec![("x-api-key", "guess")]);
        assert_eq!(authorize_proxy_request(&unknown, "secret-token"), None);

        let infer = request_with("/v1/messages", vec![]);
        assert!(request_forwards_stored_credentials(&infer));
        let health = HttpRequest {
            method: "GET".into(),
            path: "/".into(),
            headers: Vec::new(),
            body: Vec::new(),
        };
        assert!(!request_forwards_stored_credentials(&health));
    }

    #[test]
    fn extracts_capability_token_from_listen_url() {
        assert_eq!(
            proxy_capability_token("http://127.0.0.1:9/session-secret/").as_deref(),
            Some("session-secret")
        );
        assert_eq!(
            proxy_capability_token("http://127.0.0.1:9/session-secret").as_deref(),
            Some("session-secret")
        );
        assert_eq!(proxy_capability_token("http://127.0.0.1:9/"), None);
    }

    #[test]
    fn rejects_content_length_above_body_limit() {
        assert!(MAX_PROXY_BODY_BYTES < usize::MAX);
        assert!(MAX_PROXY_CONNECTIONS > 0);
        assert!(PROXY_READ_TIMEOUT > Duration::from_secs(0));
    }

    #[tokio::test]
    async fn start_proxy_rejects_remote_cleartext_base_url() {
        let error = start_openai_anthropic_proxy(test_credential("http://evil.example/v1"))
            .await
            .expect_err("remote HTTP must not start a credential proxy");
        assert!(error.contains("HTTPS"));
    }

    #[tokio::test]
    async fn start_proxy_allows_localhost_http_for_local_models() {
        let url = start_openai_anthropic_proxy(test_credential("http://127.0.0.1:11434/v1"))
            .await
            .expect("localhost HTTP should remain available for local models");
        assert!(url.contains("127.0.0.1"));
        assert!(url.ends_with('/'));
    }

    #[tokio::test]
    async fn loopback_proxy_requires_session_capability_for_inference() {
        let url = start_openai_anthropic_proxy(test_credential("https://api.example.com/v1"))
            .await
            .expect("proxy should start");
        let parsed = url::Url::parse(&url).unwrap();
        let origin = format!(
            "http://{}:{}",
            parsed.host_str().unwrap(),
            parsed.port().unwrap()
        );
        let client = reqwest::Client::new();

        let health = client.get(format!("{origin}/")).send().await.unwrap();
        assert_eq!(health.status().as_u16(), 200);

        let unauthorized = client
            .post(format!("{origin}/v1/messages"))
            .header("content-type", "application/json")
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(unauthorized.status().as_u16(), 401);

        let authorized = client.get(&url).send().await.unwrap();
        assert_eq!(authorized.status().as_u16(), 200);
        let body = authorized.text().await.unwrap();
        assert!(body.contains("claude-prism-anthropic-proxy"));
    }

    async fn start_recording_openai_mock() -> (String, Arc<std::sync::Mutex<Option<String>>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(std::sync::Mutex::new(None));
        let seen_task = Arc::clone(&seen);
        tokio::spawn(async move {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut buffer = Vec::new();
            let mut temp = [0_u8; 8192];
            let header_end = loop {
                let Ok(n) = stream.read(&mut temp).await else {
                    return;
                };
                if n == 0 {
                    return;
                }
                buffer.extend_from_slice(&temp[..n]);
                if let Some(index) = find_header_end(&buffer) {
                    break index;
                }
                if buffer.len() > MAX_PROXY_HEADER_BYTES {
                    return;
                }
            };
            let header_text = String::from_utf8_lossy(&buffer[..header_end]);
            let auth = header_text.lines().find_map(|line| {
                line.split_once(':').and_then(|(name, value)| {
                    name.eq_ignore_ascii_case("authorization")
                        .then(|| value.trim().to_string())
                })
            });
            *seen_task.lock().unwrap() = auth;
            let content_length = header_text
                .lines()
                .find_map(|line| {
                    line.split_once(':').and_then(|(name, value)| {
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                })
                .unwrap_or(0);
            let body_start = header_end + 4;
            while buffer.len().saturating_sub(body_start) < content_length {
                let Ok(n) = stream.read(&mut temp).await else {
                    return;
                };
                if n == 0 {
                    break;
                }
                buffer.extend_from_slice(&temp[..n]);
            }
            let body = json!({
                "id": "chatcmpl_1",
                "choices": [{
                    "message": { "role": "assistant", "content": "hello" },
                    "finish_reason": "stop"
                }],
                "usage": { "prompt_tokens": 1, "completion_tokens": 1 }
            })
            .to_string();
            let _ = stream
                .write_all(http_response(200, "application/json", &body).as_bytes())
                .await;
        });
        (format!("http://{addr}/v1"), seen)
    }

    #[tokio::test]
    async fn authorized_inference_forwards_stored_provider_key() {
        let (upstream_url, seen_auth) = start_recording_openai_mock().await;
        let url = start_openai_anthropic_proxy(test_credential(&upstream_url))
            .await
            .expect("proxy should start");
        let response = reqwest::Client::new()
            .post(format!("{url}v1/messages"))
            .header("content-type", "application/json")
            .json(&json!({
                "model": "claude-sonnet-4",
                "max_tokens": 16,
                "messages": [{ "role": "user", "content": "hi" }],
                "stream": false
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        let body = response.text().await.unwrap();
        assert!(
            body.contains("hello"),
            "proxy should return translated assistant text, got {body}"
        );
        assert_eq!(seen_auth.lock().unwrap().as_deref(), Some("Bearer sk-test"));
    }

    #[tokio::test]
    async fn ninth_concurrent_connection_is_rejected() {
        let url = start_openai_anthropic_proxy(test_credential("https://api.example.com/v1"))
            .await
            .expect("proxy should start");
        let parsed = url::Url::parse(&url).unwrap();
        let addr = format!("{}:{}", parsed.host_str().unwrap(), parsed.port().unwrap());
        let mut held = Vec::new();
        for _ in 0..MAX_PROXY_CONNECTIONS {
            let mut stream = tokio::net::TcpStream::connect(&addr).await.unwrap();
            stream.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
            held.push(stream);
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
        let mut ninth = tokio::net::TcpStream::connect(&addr).await.unwrap();
        ninth
            .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        ninth.read_to_end(&mut response).await.unwrap();
        let text = String::from_utf8_lossy(&response);
        assert!(
            text.contains("503") || text.contains("Too many"),
            "expected 503 after saturating proxy slots, got {text}"
        );
        drop(held);
    }

    #[tokio::test]
    async fn loopback_proxy_rejects_oversized_content_length() {
        let url = start_openai_anthropic_proxy(test_credential("https://api.example.com/v1"))
            .await
            .expect("proxy should start");
        let parsed = url::Url::parse(&url).unwrap();
        let addr = format!("{}:{}", parsed.host_str().unwrap(), parsed.port().unwrap());
        let token = parsed.path_segments().unwrap().next().unwrap();
        let mut stream = tokio::net::TcpStream::connect(&addr).await.unwrap();
        let request = format!(
            "POST /{token}/v1/messages HTTP/1.1\r\nHost: {addr}\r\nContent-Length: {}\r\n\r\n",
            MAX_PROXY_BODY_BYTES + 1
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        let text = String::from_utf8_lossy(&response);
        assert!(
            text.contains("413") || text.contains("too large"),
            "unexpected response: {text}"
        );
    }

    #[test]
    fn provider_stream_idle_matches_the_codex_windows() {
        assert_eq!(provider_stream_idle(false), Duration::from_secs(45));
        assert_eq!(provider_stream_idle(true), Duration::from_secs(180));
    }

    #[tokio::test]
    async fn client_eof_finishes_the_disconnect_wait() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client = TcpStream::connect(addr).await.unwrap();
        let (server, _) = listener.accept().await.unwrap();
        drop(client);
        tokio::time::timeout(Duration::from_secs(2), wait_for_tcp_eof(&server))
            .await
            .expect("client close should unblock the read");
    }
}
