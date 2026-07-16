use self::discovery::CodexBinary;
use super::RuntimeKind;
use serde::Serialize;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{Emitter, WebviewWindow};
use tokio::io::{AsyncRead, AsyncReadExt, BufReader};
use tokio::task::JoinHandle;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

pub mod discovery;

#[derive(Debug, Clone, PartialEq, Eq)]
struct CodexInstallCommand {
    program: PathBuf,
    args: Vec<&'static str>,
}

fn platform_codex_install_command(
    winget_program: Option<PathBuf>,
    npm_program: Option<PathBuf>,
) -> Result<CodexInstallCommand, String> {
    #[cfg(target_os = "windows")]
    {
        select_windows_codex_install_command(winget_program, npm_program)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = winget_program;
        select_unix_codex_install_command(npm_program)
    }
}

fn select_windows_codex_install_command(
    winget_program: Option<PathBuf>,
    npm_program: Option<PathBuf>,
) -> Result<CodexInstallCommand, String> {
    if let Some(program) = winget_program {
        return Ok(CodexInstallCommand {
            program,
            args: vec![
                "install",
                "--id",
                "9PLM9XGG6VKS",
                "-s",
                "msstore",
                "--accept-source-agreements",
                "--accept-package-agreements",
                "--disable-interactivity",
                "--silent",
            ],
        });
    }
    if let Some(program) = npm_program {
        return Ok(CodexInstallCommand {
            program,
            args: vec!["install", "--global", "@openai/codex"],
        });
    }
    Err(concat!(
        "No supported Codex installer was found. Install Codex from Microsoft Store product ",
        "9PLM9XGG6VKS, or install npm and run `npm install --global @openai/codex`."
    )
    .into())
}

fn select_unix_codex_install_command(
    npm_program: Option<PathBuf>,
) -> Result<CodexInstallCommand, String> {
    let program = npm_program.ok_or_else(|| {
        "npm was not found on PATH; install npm and run `npm install --global @openai/codex`."
            .to_string()
    })?;
    Ok(CodexInstallCommand {
        program,
        args: vec!["install", "--global", "@openai/codex"],
    })
}

fn existing_absolute_tool(path: PathBuf) -> Option<PathBuf> {
    if !path.is_file() {
        return None;
    }
    if path.is_absolute() {
        Some(path)
    } else {
        std::env::current_dir()
            .ok()
            .map(|directory| directory.join(path))
    }
}

fn discover_tool(names: &[&str]) -> Option<PathBuf> {
    names
        .iter()
        .filter_map(|name| which::which(name).ok())
        .find_map(existing_absolute_tool)
}

#[cfg(target_os = "windows")]
fn discover_winget() -> Option<PathBuf> {
    discover_tool(&["winget.exe", "winget"]).or_else(|| {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|root| {
                root.join("Microsoft")
                    .join("WindowsApps")
                    .join("winget.exe")
            })
            .and_then(existing_absolute_tool)
    })
}

#[cfg(not(target_os = "windows"))]
fn discover_winget() -> Option<PathBuf> {
    None
}

#[cfg(target_os = "windows")]
fn discover_npm() -> Option<PathBuf> {
    discover_tool(&["npm.cmd", "npm.exe", "npm"])
}

#[cfg(not(target_os = "windows"))]
fn discover_npm() -> Option<PathBuf> {
    discover_tool(&["npm"])
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum RuntimeInstallStream {
    Stdout,
    Stderr,
    Status,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RuntimeInstallOutput {
    runtime: RuntimeKind,
    stream: RuntimeInstallStream,
    line: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RuntimeInstallCompletion {
    runtime: RuntimeKind,
    success: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RuntimeInstallEvent {
    Output(RuntimeInstallOutput),
    Complete(RuntimeInstallCompletion),
}

trait RuntimeInstallEventSink: Clone + Send + Sync + 'static {
    fn emit(&self, event: RuntimeInstallEvent);
}

#[derive(Clone)]
struct WindowInstallEventSink {
    window: WebviewWindow,
}

impl RuntimeInstallEventSink for WindowInstallEventSink {
    fn emit(&self, event: RuntimeInstallEvent) {
        match event {
            RuntimeInstallEvent::Output(payload) => {
                let _ = self.window.emit(RUNTIME_INSTALL_OUTPUT_EVENT, payload);
            }
            RuntimeInstallEvent::Complete(payload) => {
                let _ = self.window.emit(RUNTIME_INSTALL_COMPLETE_EVENT, payload);
            }
        }
    }
}

fn runtime_install_output_event(stream: RuntimeInstallStream, line: &str) -> RuntimeInstallEvent {
    RuntimeInstallEvent::Output(RuntimeInstallOutput {
        runtime: RuntimeKind::Codex,
        stream,
        line: sanitize_install_output(line),
    })
}

fn runtime_install_completion_event(success: bool) -> RuntimeInstallEvent {
    RuntimeInstallEvent::Complete(RuntimeInstallCompletion {
        runtime: RuntimeKind::Codex,
        success,
    })
}

type InstallLifecycleFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq)]
enum InstallerStartFailure {
    Spawn(String),
    Pipe(String),
}

impl InstallerStartFailure {
    fn message(&self) -> &str {
        match self {
            Self::Spawn(message) | Self::Pipe(message) => message,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum InstallerWaitOutcome {
    Exited { success: bool },
    WaitError(String),
    TimedOut,
}

trait CodexInstallerLifecycle<S: RuntimeInstallEventSink> {
    fn start<'a>(
        &'a mut self,
        spec: &'a CodexInstallCommand,
        sink: S,
    ) -> InstallLifecycleFuture<'a, Result<(), InstallerStartFailure>>;

    fn wait<'a>(
        &'a mut self,
        timeout: Duration,
    ) -> InstallLifecycleFuture<'a, InstallerWaitOutcome>;

    fn terminate_and_reap<'a>(&'a mut self) -> InstallLifecycleFuture<'a, Result<(), String>>;

    fn finish_readers<'a>(&'a mut self, timeout: Duration) -> InstallLifecycleFuture<'a, ()>;
}

trait CodexPostInstallDiscoverer {
    fn discover<'a>(&'a mut self) -> InstallLifecycleFuture<'a, Result<CodexBinary, String>>;
}

// Stable provider-neutral installer events. Consumers distinguish concurrent providers via
// payload.runtime and stdout/stderr via payload.stream; installer arguments are never emitted.
const RUNTIME_INSTALL_OUTPUT_EVENT: &str = "runtime-install-output";
const RUNTIME_INSTALL_COMPLETE_EVENT: &str = "runtime-install-complete";
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
const INSTALL_READER_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const INSTALL_OUTPUT_LINE_LIMIT: usize = 64 * 1024;

struct CodexInstallGate {
    active: AtomicBool,
}

impl CodexInstallGate {
    const fn new() -> Self {
        Self {
            active: AtomicBool::new(false),
        }
    }

    fn acquire(&self) -> Result<CodexInstallPermit<'_>, String> {
        self.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| CodexInstallPermit { gate: self })
            .map_err(|_| "A Codex installation is already in progress.".to_string())
    }
}

struct CodexInstallPermit<'a> {
    gate: &'a CodexInstallGate,
}

impl Drop for CodexInstallPermit<'_> {
    fn drop(&mut self) {
        self.gate.active.store(false, Ordering::Release);
    }
}

async fn run_with_codex_install_guard<F, Fut>(
    gate: &CodexInstallGate,
    operation: F,
) -> Result<bool, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<bool, String>>,
{
    let _permit = gate.acquire()?;
    operation().await
}

static CODEX_INSTALL_GATE: CodexInstallGate = CodexInstallGate::new();

fn strip_ansi_sequences(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut clean = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] != 0x1b {
            clean.push(bytes[index]);
            index += 1;
            continue;
        }

        index += 1;
        match bytes.get(index).copied() {
            Some(b'[') => {
                index += 1;
                while let Some(byte) = bytes.get(index).copied() {
                    index += 1;
                    if (0x40..=0x7e).contains(&byte) {
                        break;
                    }
                }
            }
            Some(b']') => {
                index += 1;
                while index < bytes.len() {
                    if bytes[index] == 0x07 {
                        index += 1;
                        break;
                    }
                    if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'\\') {
                        index += 2;
                        break;
                    }
                    index += 1;
                }
            }
            Some(_) => index += 1,
            None => {}
        }
    }

    String::from_utf8_lossy(&clean).into_owned()
}

fn find_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| {
        window
            .iter()
            .zip(needle)
            .all(|(left, right)| left.eq_ignore_ascii_case(right))
    })
}

fn skip_whitespace(value: &str, start: usize) -> usize {
    value[start..]
        .char_indices()
        .take_while(|(_, character)| character.is_whitespace())
        .last()
        .map(|(offset, character)| start + offset + character.len_utf8())
        .unwrap_or(start)
}

fn has_identifier_before(value: &str, start: usize) -> bool {
    value[..start]
        .chars()
        .next_back()
        .is_some_and(|character| character.is_alphanumeric() || matches!(character, '_' | '-'))
}

fn sensitive_value_bounds(value: &str, start: usize) -> Option<(usize, usize)> {
    let first = value[start..].chars().next()?;
    if matches!(first, '"' | '\'') {
        let content_start = start + first.len_utf8();
        let content_end = value[content_start..]
            .char_indices()
            .find(|(_, character)| *character == first)
            .map(|(offset, _)| content_start + offset)
            .unwrap_or(value.len());
        return (content_start < content_end).then_some((content_start, content_end));
    }

    let end = value[start..]
        .char_indices()
        .find(|(_, character)| {
            character.is_whitespace()
                || matches!(
                    character,
                    '&' | ';' | ',' | '"' | '\'' | '<' | '>' | ')' | ']' | '}' | '#'
                )
        })
        .map(|(offset, _)| start + offset)
        .unwrap_or(value.len());
    (start < end).then_some((start, end))
}

fn redact_sensitive_key(value: &str, key: &str, allow_whitespace_separator: bool) -> String {
    let mut redacted = String::with_capacity(value.len());
    let mut copied_until = 0;
    let mut scan_from = 0;

    while scan_from < value.len() {
        let Some(relative) =
            find_ascii_case_insensitive(&value.as_bytes()[scan_from..], key.as_bytes())
        else {
            break;
        };
        let key_start = scan_from + relative;
        let key_end = key_start + key.len();
        if has_identifier_before(value, key_start) {
            scan_from = key_end;
            continue;
        }

        let mut separator = key_end;
        if value[separator..]
            .chars()
            .next()
            .is_some_and(|character| matches!(character, '"' | '\''))
        {
            separator += 1;
        }
        let after_key_whitespace = skip_whitespace(value, separator);
        let had_key_whitespace = after_key_whitespace > separator;
        separator = after_key_whitespace;

        if value[separator..]
            .chars()
            .next()
            .is_some_and(|character| matches!(character, '=' | ':'))
        {
            separator += 1;
            separator = skip_whitespace(value, separator);
        } else if !(allow_whitespace_separator && had_key_whitespace) {
            scan_from = key_end;
            continue;
        }

        if separator >= value.len() {
            scan_from = key_end;
            continue;
        }

        let Some((secret_start, secret_end)) = sensitive_value_bounds(value, separator) else {
            scan_from = key_end;
            continue;
        };
        redacted.push_str(&value[copied_until..secret_start]);
        redacted.push_str("[REDACTED]");
        copied_until = secret_end;
        scan_from = secret_end;
    }

    redacted.push_str(&value[copied_until..]);
    redacted
}

fn redact_authorization_field(value: &str, field: &str) -> String {
    let mut redacted = String::with_capacity(value.len());
    let mut copied_until = 0;
    let mut scan_from = 0;
    while scan_from < value.len() {
        let Some(relative) =
            find_ascii_case_insensitive(&value.as_bytes()[scan_from..], field.as_bytes())
        else {
            break;
        };
        let field_start = scan_from + relative;
        let field_end = field_start + field.len();
        if has_identifier_before(value, field_start) {
            scan_from = field_end;
            continue;
        }

        let mut separator = field_end;
        if value[separator..]
            .chars()
            .next()
            .is_some_and(|character| matches!(character, '"' | '\''))
        {
            separator += 1;
        }
        separator = skip_whitespace(value, separator);
        let Some(separator_character) = value[separator..].chars().next() else {
            break;
        };
        if !matches!(separator_character, ':' | '=') {
            scan_from = field_end;
            continue;
        }

        let mut credential_start = skip_whitespace(value, separator + 1);
        if credential_start >= value.len() {
            break;
        }

        let credential_end = match value[credential_start..].chars().next() {
            Some(quote @ ('"' | '\'')) => {
                credential_start += quote.len_utf8();
                value[credential_start..]
                    .char_indices()
                    .find(|(_, character)| *character == quote)
                    .map(|(offset, _)| credential_start + offset)
                    .unwrap_or(value.len())
            }
            _ => value[credential_start..]
                .char_indices()
                .find(|(_, character)| {
                    matches!(character, '\r' | '\n')
                        || (separator_character == '=' && matches!(character, '&' | '#'))
                })
                .map(|(offset, _)| credential_start + offset)
                .unwrap_or(value.len()),
        };
        if credential_start >= credential_end {
            scan_from = field_end;
            continue;
        }

        redacted.push_str(&value[copied_until..credential_start]);
        redacted.push_str("[REDACTED]");
        copied_until = credential_end;
        scan_from = credential_end;
    }
    redacted.push_str(&value[copied_until..]);
    redacted
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_decode_query_key(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                decoded.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        decoded.push(if bytes[index] == b'+' {
            b' '
        } else {
            bytes[index]
        });
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn is_sensitive_query_key(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase().replace(['-', ' '], "_");
    matches!(
        normalized.as_str(),
        "proxy_authorization"
            | "authorization_token"
            | "openai_api_key"
            | "anthropic_api_key"
            | "x_amz_security_token"
            | "x_amz_signature"
            | "x_amz_credential"
            | "x_goog_signature"
            | "access_token"
            | "api_key"
            | "auth_token"
            | "authorization"
            | "signature"
            | "token"
            | "auth"
            | "sig"
            | "key"
    )
}

fn redact_sensitive_query_values(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut redacted = String::with_capacity(value.len());
    let mut copied_until = 0;
    let mut index = 0;
    while index < bytes.len() {
        if !matches!(bytes[index], b'?' | b'&') {
            index += 1;
            continue;
        }
        let key_start = index + 1;
        let mut key_end = key_start;
        while key_end < bytes.len() && !matches!(bytes[key_end], b'=' | b'&' | b'#' | b' ' | b'\t')
        {
            key_end += 1;
        }
        if key_end >= bytes.len()
            || bytes[key_end] != b'='
            || !is_sensitive_query_key(&percent_decode_query_key(&value[key_start..key_end]))
        {
            index = key_end.max(index + 1);
            continue;
        }
        let value_start = key_end + 1;
        let mut value_end = value_start;
        while value_end < bytes.len()
            && !matches!(bytes[value_end], b'&' | b'#' | b' ' | b'\t' | b'\r' | b'\n')
        {
            value_end += 1;
        }
        if value_start < value_end {
            redacted.push_str(&value[copied_until..value_start]);
            redacted.push_str("[REDACTED]");
            copied_until = value_end;
        }
        index = value_end.max(index + 1);
    }
    redacted.push_str(&value[copied_until..]);
    redacted
}

fn redact_standalone_api_keys(value: &str) -> String {
    value
        .split_inclusive(char::is_whitespace)
        .map(|part| {
            let token = part.trim_end_matches(char::is_whitespace);
            let whitespace = &part[token.len()..];
            if token.len() > 8 && token.to_ascii_lowercase().starts_with("sk-") {
                format!("[REDACTED]{whitespace}")
            } else {
                part.to_owned()
            }
        })
        .collect()
}

fn sanitize_install_output(value: &str) -> String {
    let mut clean = strip_ansi_sequences(value);
    clean = redact_authorization_field(&clean, "proxy-authorization");
    clean = redact_authorization_field(&clean, "authorization");
    clean = redact_sensitive_query_values(&clean);
    clean = redact_sensitive_key(&clean, "bearer", true);
    for (key, allow_whitespace_separator) in [
        ("authorization_token", false),
        ("authorization-token", false),
        ("openai_api_key", false),
        ("anthropic_api_key", false),
        ("x-amz-security-token", false),
        ("x-amz-signature", false),
        ("x-amz-credential", false),
        ("x-goog-signature", false),
        ("access_token", false),
        ("access-token", true),
        ("access token", true),
        ("api_key", false),
        ("api-key", false),
        ("api key", true),
        ("auth_token", false),
        ("auth-token", false),
        ("signature", false),
        ("token", false),
        ("auth", false),
        ("sig", false),
        ("key", false),
    ] {
        clean = redact_sensitive_key(&clean, key, allow_whitespace_separator);
    }
    redact_standalone_api_keys(&clean)
}

fn emit_installer_line<S: RuntimeInstallEventSink>(
    sink: &S,
    stream: RuntimeInstallStream,
    line: &mut Vec<u8>,
    truncated: bool,
) {
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    let decoded = String::from_utf8_lossy(line);
    sink.emit(runtime_install_output_event(stream, &decoded));
    if truncated {
        sink.emit(runtime_install_output_event(
            RuntimeInstallStream::Status,
            "Codex installer output line was truncated at 64 KiB while the stream continued draining.",
        ));
    }
}

async fn stream_installer_lines<R, S>(sink: S, stream: RuntimeInstallStream, mut reader: R)
where
    R: AsyncRead + Unpin,
    S: RuntimeInstallEventSink,
{
    let mut read_buffer = [0_u8; 8 * 1024];
    let mut line = Vec::with_capacity(8 * 1024);
    let mut truncated = false;

    loop {
        match reader.read(&mut read_buffer).await {
            Ok(0) => {
                if !line.is_empty() || truncated {
                    emit_installer_line(&sink, stream, &mut line, truncated);
                }
                break;
            }
            Ok(read) => {
                for byte in &read_buffer[..read] {
                    if *byte == b'\n' {
                        emit_installer_line(&sink, stream, &mut line, truncated);
                        line.clear();
                        truncated = false;
                    } else if line.len() < INSTALL_OUTPUT_LINE_LIMIT {
                        line.push(*byte);
                    } else {
                        truncated = true;
                    }
                }
            }
            Err(error) => {
                if !line.is_empty() || truncated {
                    emit_installer_line(&sink, stream, &mut line, truncated);
                }
                sink.emit(runtime_install_output_event(
                    RuntimeInstallStream::Status,
                    &format!("Codex installer output stream ended after a read error: {error}"),
                ));
                break;
            }
        }
    }
}

#[derive(Default)]
struct ProcessCodexInstallerLifecycle {
    child: Option<tokio::process::Child>,
    reader_tasks: Vec<JoinHandle<()>>,
}

impl<S: RuntimeInstallEventSink> CodexInstallerLifecycle<S> for ProcessCodexInstallerLifecycle {
    fn start<'a>(
        &'a mut self,
        spec: &'a CodexInstallCommand,
        sink: S,
    ) -> InstallLifecycleFuture<'a, Result<(), InstallerStartFailure>> {
        Box::pin(async move {
            let mut command = tokio::process::Command::new(&spec.program);
            command
                .args(&spec.args)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            #[cfg(target_os = "windows")]
            command.as_std_mut().creation_flags(0x0800_0000);

            let mut child = command.spawn().map_err(|error| {
                InstallerStartFailure::Spawn(format!(
                    "Codex installer could not be started: {error}"
                ))
            })?;
            let Some(stdout) = child.stdout.take() else {
                self.child = Some(child);
                return Err(InstallerStartFailure::Pipe(
                    "Codex installer stdout was unavailable".into(),
                ));
            };
            let Some(stderr) = child.stderr.take() else {
                self.child = Some(child);
                return Err(InstallerStartFailure::Pipe(
                    "Codex installer stderr was unavailable".into(),
                ));
            };

            self.child = Some(child);
            self.reader_tasks.push(tokio::spawn(stream_installer_lines(
                sink.clone(),
                RuntimeInstallStream::Stdout,
                BufReader::new(stdout),
            )));
            self.reader_tasks.push(tokio::spawn(stream_installer_lines(
                sink,
                RuntimeInstallStream::Stderr,
                BufReader::new(stderr),
            )));
            Ok(())
        })
    }

    fn wait<'a>(
        &'a mut self,
        timeout: Duration,
    ) -> InstallLifecycleFuture<'a, InstallerWaitOutcome> {
        Box::pin(async move {
            let Some(child) = self.child.as_mut() else {
                return InstallerWaitOutcome::WaitError(
                    "Codex installer process was unavailable".into(),
                );
            };
            let outcome = tokio::time::timeout(timeout, child.wait()).await;
            match outcome {
                Ok(Ok(status)) => {
                    self.child.take();
                    InstallerWaitOutcome::Exited {
                        success: status.success(),
                    }
                }
                Ok(Err(error)) => InstallerWaitOutcome::WaitError(format!(
                    "Codex installer failed while waiting: {error}"
                )),
                Err(_) => InstallerWaitOutcome::TimedOut,
            }
        })
    }

    fn terminate_and_reap<'a>(&'a mut self) -> InstallLifecycleFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let Some(mut child) = self.child.take() else {
                return Ok(());
            };
            let kill_error = child.kill().await.err();
            match child.wait().await {
                Ok(_) => Ok(()),
                Err(wait_error) => {
                    let kill_detail = kill_error
                        .map(|error| format!("; termination also failed: {error}"))
                        .unwrap_or_default();
                    Err(format!(
                        "Codex installer could not be reaped: {wait_error}{kill_detail}"
                    ))
                }
            }
        })
    }

    fn finish_readers<'a>(&'a mut self, timeout: Duration) -> InstallLifecycleFuture<'a, ()> {
        Box::pin(async move {
            for mut task in self.reader_tasks.drain(..) {
                if tokio::time::timeout(timeout, &mut task).await.is_err() {
                    task.abort();
                    let _ = task.await;
                }
            }
        })
    }
}

#[derive(Default)]
struct ProcessCodexPostInstallDiscoverer;

impl CodexPostInstallDiscoverer for ProcessCodexPostInstallDiscoverer {
    fn discover<'a>(&'a mut self) -> InstallLifecycleFuture<'a, Result<CodexBinary, String>> {
        Box::pin(async { discovery::discover_codex_binary().await })
    }
}

enum InstallerTerminalState {
    Rediscover,
    Failed,
    Error(String),
}

async fn orchestrate_codex_installation<R, D, S>(
    lifecycle: &mut R,
    discoverer: &mut D,
    sink: S,
    spec: &CodexInstallCommand,
    install_timeout: Duration,
    reader_timeout: Duration,
) -> Result<bool, String>
where
    R: CodexInstallerLifecycle<S>,
    D: CodexPostInstallDiscoverer,
    S: RuntimeInstallEventSink,
{
    let terminal = match lifecycle.start(spec, sink.clone()).await {
        Err(InstallerStartFailure::Spawn(message)) => {
            sink.emit(runtime_install_output_event(
                RuntimeInstallStream::Stderr,
                &message,
            ));
            InstallerTerminalState::Error(message)
        }
        Err(failure @ InstallerStartFailure::Pipe(_)) => {
            let mut message = failure.message().to_owned();
            sink.emit(runtime_install_output_event(
                RuntimeInstallStream::Stderr,
                &message,
            ));
            if let Err(cleanup_error) = lifecycle.terminate_and_reap().await {
                sink.emit(runtime_install_output_event(
                    RuntimeInstallStream::Stderr,
                    &cleanup_error,
                ));
                message.push_str("; ");
                message.push_str(&cleanup_error);
            }
            InstallerTerminalState::Error(message)
        }
        Ok(()) => match lifecycle.wait(install_timeout).await {
            InstallerWaitOutcome::Exited { success: true } => InstallerTerminalState::Rediscover,
            InstallerWaitOutcome::Exited { success: false } => InstallerTerminalState::Failed,
            InstallerWaitOutcome::WaitError(mut message) => {
                sink.emit(runtime_install_output_event(
                    RuntimeInstallStream::Stderr,
                    &message,
                ));
                if let Err(cleanup_error) = lifecycle.terminate_and_reap().await {
                    sink.emit(runtime_install_output_event(
                        RuntimeInstallStream::Stderr,
                        &cleanup_error,
                    ));
                    message.push_str("; ");
                    message.push_str(&cleanup_error);
                }
                InstallerTerminalState::Error(message)
            }
            InstallerWaitOutcome::TimedOut => {
                let timeout_message = "Codex installer timed out after 10 minutes.";
                sink.emit(runtime_install_output_event(
                    RuntimeInstallStream::Stderr,
                    timeout_message,
                ));
                match lifecycle.terminate_and_reap().await {
                    Ok(()) => InstallerTerminalState::Failed,
                    Err(cleanup_error) => {
                        sink.emit(runtime_install_output_event(
                            RuntimeInstallStream::Stderr,
                            &cleanup_error,
                        ));
                        InstallerTerminalState::Error(format!("{timeout_message} {cleanup_error}"))
                    }
                }
            }
        },
    };

    lifecycle.finish_readers(reader_timeout).await;

    let result = match terminal {
        InstallerTerminalState::Rediscover => match discoverer.discover().await {
            Ok(_) => Ok(true),
            Err(_) => {
                sink.emit(runtime_install_output_event(
                    RuntimeInstallStream::Stderr,
                    "Installer exited successfully, but no validated Codex CLI was found.",
                ));
                Ok(false)
            }
        },
        InstallerTerminalState::Failed => {
            sink.emit(runtime_install_output_event(
                RuntimeInstallStream::Status,
                "Codex installation did not complete successfully.",
            ));
            Ok(false)
        }
        InstallerTerminalState::Error(message) => Err(sanitize_install_output(&message)),
    };

    sink.emit(runtime_install_completion_event(matches!(result, Ok(true))));
    result
}

async fn install_codex_cli_inner(window: WebviewWindow) -> Result<bool, String> {
    let sink = WindowInstallEventSink { window };
    let spec = match platform_codex_install_command(discover_winget(), discover_npm()) {
        Ok(spec) => spec,
        Err(message) => {
            sink.emit(runtime_install_output_event(
                RuntimeInstallStream::Stderr,
                &message,
            ));
            sink.emit(runtime_install_completion_event(false));
            return Err(sanitize_install_output(&message));
        }
    };
    orchestrate_codex_installation(
        &mut ProcessCodexInstallerLifecycle::default(),
        &mut ProcessCodexPostInstallDiscoverer,
        sink,
        &spec,
        INSTALL_TIMEOUT,
        INSTALL_READER_DRAIN_TIMEOUT,
    )
    .await
}

pub(super) async fn install(window: WebviewWindow) -> Result<bool, String> {
    run_with_codex_install_guard(&CODEX_INSTALL_GATE, || install_codex_cli_inner(window)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    #[test]
    fn platform_installer_uses_the_official_codex_command() {
        let spec = platform_codex_install_command(
            Some(PathBuf::from("/test/winget")),
            Some(PathBuf::from("/test/npm")),
        )
        .unwrap();

        #[cfg(target_os = "windows")]
        {
            assert_eq!(spec.program, PathBuf::from("/test/winget"));
            assert_eq!(
                spec.args,
                [
                    "install",
                    "--id",
                    "9PLM9XGG6VKS",
                    "-s",
                    "msstore",
                    "--accept-source-agreements",
                    "--accept-package-agreements",
                    "--disable-interactivity",
                    "--silent",
                ]
            );
        }

        #[cfg(not(target_os = "windows"))]
        {
            assert_eq!(spec.program, PathBuf::from("/test/npm"));
            assert_eq!(spec.args, ["install", "--global", "@openai/codex"]);
        }
    }

    #[test]
    fn windows_installer_selection_prefers_winget_then_falls_back_to_npm() {
        let winget = PathBuf::from("/tools/winget.exe");
        let npm = PathBuf::from("/tools/npm.cmd");

        let store =
            select_windows_codex_install_command(Some(winget.clone()), Some(npm.clone())).unwrap();
        assert_eq!(store.program, winget);
        assert!(store.args.contains(&"--disable-interactivity"));
        assert!(store.args.contains(&"--silent"));

        let fallback = select_windows_codex_install_command(None, Some(npm.clone())).unwrap();
        assert_eq!(fallback.program, npm);
        assert_eq!(fallback.args, ["install", "--global", "@openai/codex"]);

        let error = select_windows_codex_install_command(None, None).unwrap_err();
        assert!(error.contains("9PLM9XGG6VKS"));
        assert!(error.contains("npm install --global @openai/codex"));
    }

    #[test]
    fn install_output_is_provider_scoped_ansi_free_and_redacted() {
        let original = concat!(
            "\u{1b}[31mOPENAI_API_KEY=sk-original-secret ",
            "access-token access-original-secret ",
            "Authorization: Bearer bearer-original-secret ",
            "https://download.test/file?token=url-original-secret&",
            "x-amz-signature=signed-original-secret&key=query-key-secret\u{1b}[0m"
        );
        let clean = sanitize_install_output(original);

        for secret in [
            "sk-original-secret",
            "access-original-secret",
            "bearer-original-secret",
            "url-original-secret",
            "signed-original-secret",
            "query-key-secret",
        ] {
            assert!(!clean.contains(secret), "secret was not redacted: {secret}");
        }
        assert!(!clean.contains('\u{1b}'));
        assert!(clean.contains("[REDACTED]"));

        let payload = RuntimeInstallOutput {
            runtime: RuntimeKind::Codex,
            stream: RuntimeInstallStream::Stdout,
            line: clean,
        };
        let value = serde_json::to_value(payload).unwrap();
        assert_eq!(value["runtime"], "codex");
        assert_eq!(value["stream"], "stdout");
    }

    #[test]
    fn install_output_redacts_all_supported_secret_syntaxes_without_losing_context() {
        let cases = [
            ("OPENAI_API_KEY=unquoted-secret", "unquoted-secret"),
            ("api_key='single-quoted-secret'", "single-quoted-secret"),
            ("Api-Key=\"double-quoted-secret\"", "double-quoted-secret"),
            (r#"{"api_key":"json-api-secret"}"#, "json-api-secret"),
            (
                r#"{"access_token": "json-access-secret"}"#,
                "json-access-secret",
            ),
            ("access-token access-dash-secret", "access-dash-secret"),
            ("Access Token: access-label-secret", "access-label-secret"),
            (
                "Authorization: Bearer authorization-header-secret",
                "authorization-header-secret",
            ),
            (
                "Authorization: Basic basic-credential-secret",
                "basic-credential-secret",
            ),
            (
                "Authorization: Digest username=alice,realm=digest-realm-secret,nonce=digest-nonce-secret",
                "digest-realm-secret",
            ),
            (
                "Authorization: Digest username=alice,realm=digest-realm-secret,nonce=digest-nonce-secret",
                "digest-nonce-secret",
            ),
            (
                "Authorization: Custom custom-credential-secret",
                "custom-credential-secret",
            ),
            (
                "Proxy-Authorization: Basic proxy-credential-secret",
                "proxy-credential-secret",
            ),
            (
                "authorization=Basic assignment-credential-secret",
                "assignment-credential-secret",
            ),
            (
                "proxy-authorization=Digest nonce=assignment-proxy-secret",
                "assignment-proxy-secret",
            ),
            (
                "proxy says bEaReR bearer-shaped-secret",
                "bearer-shaped-secret",
            ),
            ("?token=url-token-secret&other=visible", "url-token-secret"),
            ("?key=url-key-secret&other=visible", "url-key-secret"),
            (
                "?api_key=url-api-key-secret&other=visible",
                "url-api-key-secret",
            ),
            (
                "?access_token=url-access-token-secret&other=visible",
                "url-access-token-secret",
            ),
            (
                "?access%5Ftoken=encoded-access-token-secret&other=visible",
                "encoded-access-token-secret",
            ),
            (
                "?signature=url-signature-secret&other=visible",
                "url-signature-secret",
            ),
            ("?sig=url-sig-secret&other=visible", "url-sig-secret"),
            (
                "?X-AmZ-SiGnAtUrE=url-amz-signature-secret&other=visible",
                "url-amz-signature-secret",
            ),
            (
                "?authorization=url-authorization-secret&other=visible",
                "url-authorization-secret",
            ),
            ("?auth=url-auth-secret&other=visible", "url-auth-secret"),
            (
                "?x-amz-credential=url-amz-credential-secret&other=visible",
                "url-amz-credential-secret",
            ),
            (
                "?x-amz-security-token=url-amz-security-secret&other=visible",
                "url-amz-security-secret",
            ),
            (
                "?x-goog-signature=url-google-signature-secret&other=visible",
                "url-google-signature-secret",
            ),
        ];

        for (input, secret) in cases {
            let clean = sanitize_install_output(&format!("prefix {input} suffix"));
            assert!(
                !clean.contains(secret),
                "secret syntax was not redacted: {input} => {clean}"
            );
            assert!(clean.starts_with("prefix "));
            if !input.to_ascii_lowercase().contains("authorization:")
                && !input.to_ascii_lowercase().contains("authorization=")
            {
                assert!(clean.ends_with(" suffix"));
            }
        }

        let ansi = sanitize_install_output("\u{1b}[32mToken=ansi-secret\u{1b}[0m visible");
        assert!(!ansi.contains("ansi-secret"));
        assert!(!ansi.contains('\u{1b}'));
        assert!(ansi.ends_with(" visible"));

        for benign in [
            "key not found",
            "token cache is empty",
            "auth helper is unavailable",
            "signature verification failed",
        ] {
            assert_eq!(sanitize_install_output(benign), benign);
        }

        let multiline = sanitize_install_output(
            "Authorization: Basic multiline-secret\nnext installer line is visible",
        );
        assert!(!multiline.contains("multiline-secret"));
        assert!(multiline.contains("next installer line is visible"));
    }

    #[tokio::test]
    async fn production_installer_reader_caps_no_newline_output_and_warns() {
        let mut bytes = b"token=oversized-stream-secret ".to_vec();
        bytes.extend(std::iter::repeat_n(b'x', 128 * 1024));
        let sink = RecordingInstallSink::default();

        stream_installer_lines(
            sink.clone(),
            RuntimeInstallStream::Stdout,
            BufReader::new(std::io::Cursor::new(bytes)),
        )
        .await;

        let events = sink.events();
        assert!(!format!("{events:?}").contains("oversized-stream-secret"));
        assert!(events.iter().any(|event| matches!(
            event,
            RuntimeInstallEvent::Output(RuntimeInstallOutput { line, .. })
                if line.to_ascii_lowercase().contains("truncated")
        )));
        assert!(events.iter().all(|event| match event {
            RuntimeInstallEvent::Output(RuntimeInstallOutput { line, .. }) => {
                line.len() <= 64 * 1024
            }
            RuntimeInstallEvent::Complete(_) => true,
        }));
    }

    #[tokio::test]
    async fn production_installer_reader_decodes_invalid_utf8_lossily_and_keeps_draining() {
        let bytes = b"first \xff token=invalid-stream-secret\nsecond visible\n";
        let sink = RecordingInstallSink::default();

        stream_installer_lines(
            sink.clone(),
            RuntimeInstallStream::Stderr,
            BufReader::new(std::io::Cursor::new(bytes)),
        )
        .await;

        let events = sink.events();
        assert!(!format!("{events:?}").contains("invalid-stream-secret"));
        assert!(events.iter().any(|event| matches!(
            event,
            RuntimeInstallEvent::Output(RuntimeInstallOutput { line, .. })
                if line.contains('\u{fffd}')
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            RuntimeInstallEvent::Output(RuntimeInstallOutput { line, .. })
                if line == "second visible"
        )));
    }

    #[tokio::test]
    async fn production_installer_reader_emits_partial_output_and_warning_on_read_error() {
        struct ErrorAfterChunk(Option<Vec<u8>>);

        impl tokio::io::AsyncRead for ErrorAfterChunk {
            fn poll_read(
                mut self: std::pin::Pin<&mut Self>,
                _context: &mut std::task::Context<'_>,
                buffer: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                if let Some(chunk) = self.0.take() {
                    buffer.put_slice(&chunk);
                    std::task::Poll::Ready(Ok(()))
                } else {
                    std::task::Poll::Ready(Err(std::io::Error::other("synthetic read failure")))
                }
            }
        }

        let sink = RecordingInstallSink::default();
        stream_installer_lines(
            sink.clone(),
            RuntimeInstallStream::Stdout,
            ErrorAfterChunk(Some(b"token=read-error-secret partial visible".to_vec())),
        )
        .await;

        let events = sink.events();
        assert!(!format!("{events:?}").contains("read-error-secret"));
        assert!(events.iter().any(|event| matches!(
            event,
            RuntimeInstallEvent::Output(RuntimeInstallOutput { line, .. })
                if line.contains("partial visible")
        )));
        assert!(events.iter().any(|event| matches!(
            event,
            RuntimeInstallEvent::Output(RuntimeInstallOutput { line, stream, .. })
                if *stream == RuntimeInstallStream::Status
                    && line.contains("read error")
                    && line.contains("synthetic read failure")
        )));
    }

    #[tokio::test]
    async fn codex_install_single_flight_rejects_overlap_and_releases_after_error() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use tokio::sync::Notify;

        let gate = Arc::new(CodexInstallGate::new());
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let first_gate = gate.clone();
        let first_entered = entered.clone();
        let first_release = release.clone();
        let first = tokio::spawn(async move {
            run_with_codex_install_guard(first_gate.as_ref(), || async move {
                first_entered.notify_one();
                first_release.notified().await;
                Ok(true)
            })
            .await
        });
        entered.notified().await;

        let overlap_ran = Arc::new(AtomicBool::new(false));
        let overlap_flag = overlap_ran.clone();
        let overlap = run_with_codex_install_guard(gate.as_ref(), || async move {
            overlap_flag.store(true, Ordering::SeqCst);
            Ok(true)
        })
        .await
        .unwrap_err();
        assert!(overlap.contains("already in progress"));
        assert!(!overlap_ran.load(Ordering::SeqCst));

        release.notify_one();
        assert_eq!(first.await.unwrap(), Ok(true));

        let failed = run_with_codex_install_guard(gate.as_ref(), || async {
            Err("installer failed".to_string())
        })
        .await;
        assert_eq!(failed, Err("installer failed".to_string()));
        assert_eq!(
            run_with_codex_install_guard(gate.as_ref(), || async { Ok(false) }).await,
            Ok(false)
        );
    }

    #[derive(Clone, Default)]
    struct RecordingInstallSink {
        events: Arc<Mutex<Vec<RuntimeInstallEvent>>>,
    }

    impl RuntimeInstallEventSink for RecordingInstallSink {
        fn emit(&self, event: RuntimeInstallEvent) {
            self.events.lock().unwrap().push(event);
        }
    }

    impl RecordingInstallSink {
        fn events(&self) -> Vec<RuntimeInstallEvent> {
            self.events.lock().unwrap().clone()
        }
    }

    struct FakeInstallerLifecycle {
        start_result: Result<(), InstallerStartFailure>,
        wait_outcome: InstallerWaitOutcome,
        stream_line: Option<String>,
        terminate_result: Result<(), String>,
        start_calls: usize,
        wait_calls: usize,
        terminate_calls: usize,
        finish_reader_calls: usize,
        killed: bool,
        reaped: bool,
    }

    impl FakeInstallerLifecycle {
        fn new(
            start_result: Result<(), InstallerStartFailure>,
            wait_outcome: InstallerWaitOutcome,
        ) -> Self {
            Self {
                start_result,
                wait_outcome,
                stream_line: None,
                terminate_result: Ok(()),
                start_calls: 0,
                wait_calls: 0,
                terminate_calls: 0,
                finish_reader_calls: 0,
                killed: false,
                reaped: false,
            }
        }
    }

    impl<S: RuntimeInstallEventSink> CodexInstallerLifecycle<S> for FakeInstallerLifecycle {
        fn start<'a>(
            &'a mut self,
            _spec: &'a CodexInstallCommand,
            sink: S,
        ) -> InstallLifecycleFuture<'a, Result<(), InstallerStartFailure>> {
            self.start_calls += 1;
            if let Some(line) = self.stream_line.clone() {
                sink.emit(runtime_install_output_event(
                    RuntimeInstallStream::Stdout,
                    &line,
                ));
            }
            let result = self.start_result.clone();
            Box::pin(async move { result })
        }

        fn wait<'a>(
            &'a mut self,
            _timeout: Duration,
        ) -> InstallLifecycleFuture<'a, InstallerWaitOutcome> {
            self.wait_calls += 1;
            let outcome = self.wait_outcome.clone();
            Box::pin(async move { outcome })
        }

        fn terminate_and_reap<'a>(&'a mut self) -> InstallLifecycleFuture<'a, Result<(), String>> {
            self.terminate_calls += 1;
            self.killed = true;
            self.reaped = true;
            let result = self.terminate_result.clone();
            Box::pin(async move { result })
        }

        fn finish_readers<'a>(&'a mut self, _timeout: Duration) -> InstallLifecycleFuture<'a, ()> {
            self.finish_reader_calls += 1;
            Box::pin(async {})
        }
    }

    struct FakePostInstallDiscoverer {
        result: Result<CodexBinary, String>,
        calls: usize,
    }

    impl CodexPostInstallDiscoverer for FakePostInstallDiscoverer {
        fn discover<'a>(&'a mut self) -> InstallLifecycleFuture<'a, Result<CodexBinary, String>> {
            self.calls += 1;
            let result = self.result.clone();
            Box::pin(async move { result })
        }
    }

    fn fake_install_spec() -> CodexInstallCommand {
        CodexInstallCommand {
            program: PathBuf::from("installer"),
            args: vec!["install"],
        }
    }

    fn completion_values(events: &[RuntimeInstallEvent]) -> Vec<bool> {
        events
            .iter()
            .filter_map(|event| match event {
                RuntimeInstallEvent::Complete(payload) => Some(payload.success),
                RuntimeInstallEvent::Output(_) => None,
            })
            .collect()
    }

    fn assert_one_terminal_completion(events: &[RuntimeInstallEvent], expected: bool) {
        assert_eq!(completion_values(events), vec![expected]);
        assert!(matches!(
            events.last(),
            Some(RuntimeInstallEvent::Complete(RuntimeInstallCompletion {
                success,
                ..
            })) if *success == expected
        ));
    }

    #[tokio::test]
    async fn installer_success_requires_fresh_discovery_and_completes_once_last() {
        let mut lifecycle =
            FakeInstallerLifecycle::new(Ok(()), InstallerWaitOutcome::Exited { success: true });
        lifecycle.stream_line = Some("installing".into());
        let mut discoverer = FakePostInstallDiscoverer {
            result: Ok(CodexBinary {
                path: PathBuf::from("validated-codex"),
                version: "0.135.0".into(),
            }),
            calls: 0,
        };
        let sink = RecordingInstallSink::default();

        let result = orchestrate_codex_installation(
            &mut lifecycle,
            &mut discoverer,
            sink.clone(),
            &fake_install_spec(),
            Duration::from_millis(20),
            Duration::from_millis(20),
        )
        .await;

        assert_eq!(result, Ok(true));
        assert_eq!(discoverer.calls, 1);
        assert_eq!(lifecycle.terminate_calls, 0);
        assert_eq!(lifecycle.finish_reader_calls, 1);
        let events = sink.events();
        assert!(matches!(
            events.first(),
            Some(RuntimeInstallEvent::Output(RuntimeInstallOutput {
                stream: RuntimeInstallStream::Stdout,
                line,
                ..
            })) if line == "installing"
        ));
        assert_one_terminal_completion(&events, true);
    }

    #[tokio::test]
    async fn successful_exit_with_failed_rediscovery_returns_false_and_completes_once() {
        let mut lifecycle =
            FakeInstallerLifecycle::new(Ok(()), InstallerWaitOutcome::Exited { success: true });
        let mut discoverer = FakePostInstallDiscoverer {
            result: Err("not found".into()),
            calls: 0,
        };
        let sink = RecordingInstallSink::default();

        let result = orchestrate_codex_installation(
            &mut lifecycle,
            &mut discoverer,
            sink.clone(),
            &fake_install_spec(),
            Duration::from_millis(20),
            Duration::from_millis(20),
        )
        .await;

        assert_eq!(result, Ok(false));
        assert_eq!(discoverer.calls, 1);
        let events = sink.events();
        assert!(events.iter().any(|event| matches!(
            event,
            RuntimeInstallEvent::Output(RuntimeInstallOutput {
                stream: RuntimeInstallStream::Stderr,
                line,
                ..
            }) if line.contains("no validated Codex CLI")
        )));
        assert_one_terminal_completion(&events, false);
    }

    #[tokio::test]
    async fn nonzero_installer_exit_skips_rediscovery_and_completes_once() {
        let mut lifecycle =
            FakeInstallerLifecycle::new(Ok(()), InstallerWaitOutcome::Exited { success: false });
        let mut discoverer = FakePostInstallDiscoverer {
            result: Err("must not be called".into()),
            calls: 0,
        };
        let sink = RecordingInstallSink::default();

        let result = orchestrate_codex_installation(
            &mut lifecycle,
            &mut discoverer,
            sink.clone(),
            &fake_install_spec(),
            Duration::from_millis(20),
            Duration::from_millis(20),
        )
        .await;

        assert_eq!(result, Ok(false));
        assert_eq!(discoverer.calls, 0);
        assert_eq!(lifecycle.terminate_calls, 0);
        assert_eq!(lifecycle.finish_reader_calls, 1);
        assert_one_terminal_completion(&sink.events(), false);
    }

    #[tokio::test]
    async fn installer_timeout_terminates_reaps_and_completes_once() {
        let mut lifecycle = FakeInstallerLifecycle::new(Ok(()), InstallerWaitOutcome::TimedOut);
        let mut discoverer = FakePostInstallDiscoverer {
            result: Err("must not be called".into()),
            calls: 0,
        };
        let sink = RecordingInstallSink::default();

        let result = orchestrate_codex_installation(
            &mut lifecycle,
            &mut discoverer,
            sink.clone(),
            &fake_install_spec(),
            Duration::from_millis(20),
            Duration::from_millis(20),
        )
        .await;

        assert_eq!(result, Ok(false));
        assert_eq!(discoverer.calls, 0);
        assert_eq!(lifecycle.terminate_calls, 1);
        assert!(lifecycle.killed);
        assert!(lifecycle.reaped);
        assert_eq!(lifecycle.finish_reader_calls, 1);
        assert_one_terminal_completion(&sink.events(), false);
    }

    #[tokio::test]
    async fn spawn_pipe_and_wait_errors_complete_once_and_redact_error_secrets() {
        let cases = [
            (
                InstallerStartFailure::Spawn("token=spawn-secret".into()),
                InstallerWaitOutcome::Exited { success: true },
                0,
                "spawn-secret",
            ),
            (
                InstallerStartFailure::Pipe("api_key='pipe-secret'".into()),
                InstallerWaitOutcome::Exited { success: true },
                1,
                "pipe-secret",
            ),
        ];

        for (failure, wait_outcome, expected_terminations, secret) in cases {
            let mut lifecycle = FakeInstallerLifecycle::new(Err(failure), wait_outcome);
            let mut discoverer = FakePostInstallDiscoverer {
                result: Err("must not be called".into()),
                calls: 0,
            };
            let sink = RecordingInstallSink::default();
            let result = orchestrate_codex_installation(
                &mut lifecycle,
                &mut discoverer,
                sink.clone(),
                &fake_install_spec(),
                Duration::from_millis(20),
                Duration::from_millis(20),
            )
            .await;

            assert!(result.is_err());
            assert_eq!(discoverer.calls, 0);
            assert_eq!(lifecycle.terminate_calls, expected_terminations);
            if expected_terminations == 1 {
                assert!(lifecycle.killed && lifecycle.reaped);
            }
            assert_eq!(lifecycle.finish_reader_calls, 1);
            let events = sink.events();
            assert!(!format!("{result:?}").contains(secret));
            assert!(!format!("{events:?}").contains(secret));
            assert_one_terminal_completion(&events, false);
        }

        let mut lifecycle = FakeInstallerLifecycle::new(
            Ok(()),
            InstallerWaitOutcome::WaitError("Authorization: Bearer wait-secret".into()),
        );
        let mut discoverer = FakePostInstallDiscoverer {
            result: Err("must not be called".into()),
            calls: 0,
        };
        let sink = RecordingInstallSink::default();
        let result = orchestrate_codex_installation(
            &mut lifecycle,
            &mut discoverer,
            sink.clone(),
            &fake_install_spec(),
            Duration::from_millis(20),
            Duration::from_millis(20),
        )
        .await;

        assert!(result.is_err());
        assert_eq!(discoverer.calls, 0);
        assert_eq!(lifecycle.terminate_calls, 1);
        assert!(lifecycle.killed && lifecycle.reaped);
        assert_eq!(lifecycle.finish_reader_calls, 1);
        let events = sink.events();
        assert!(!format!("{result:?}").contains("wait-secret"));
        assert!(!format!("{events:?}").contains("wait-secret"));
        assert_one_terminal_completion(&events, false);
    }

    #[tokio::test]
    async fn production_lifecycle_times_out_reaps_child_and_bounds_reader_shutdown() {
        #[cfg(target_os = "windows")]
        let spec = CodexInstallCommand {
            program: PathBuf::from("powershell.exe"),
            args: vec![
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Write-Output 'token=production-secret'; Start-Sleep -Seconds 5",
            ],
        };
        #[cfg(not(target_os = "windows"))]
        let spec = CodexInstallCommand {
            program: PathBuf::from("sh"),
            args: vec!["-c", "printf 'token=production-secret\\n'; sleep 5"],
        };

        let mut lifecycle = ProcessCodexInstallerLifecycle::default();
        let mut discoverer = FakePostInstallDiscoverer {
            result: Err("must not be called".into()),
            calls: 0,
        };
        let sink = RecordingInstallSink::default();
        let result = orchestrate_codex_installation(
            &mut lifecycle,
            &mut discoverer,
            sink.clone(),
            &spec,
            Duration::from_millis(100),
            Duration::from_millis(100),
        )
        .await;

        assert_eq!(result, Ok(false));
        assert_eq!(discoverer.calls, 0);
        assert!(lifecycle.child.is_none());
        assert!(lifecycle.reader_tasks.is_empty());
        let events = sink.events();
        assert!(!format!("{events:?}").contains("production-secret"));
        assert_one_terminal_completion(&events, false);
    }
}
