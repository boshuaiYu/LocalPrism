use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tauri::{Emitter, WebviewWindow};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

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

#[tauri::command]
pub async fn runtime_status(runtime: RuntimeKind) -> Result<RuntimeAccount, String> {
    match runtime {
        RuntimeKind::Claude => crate::claude::check_claude_status()
            .await
            .map(claude::account_from_status),
        RuntimeKind::Codex => {
            let binary = codex::discovery::discover_codex_binary().await.ok();
            Ok(codex_account_from_binary(binary.as_ref()))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CodexInstallCommand {
    program: PathBuf,
    args: Vec<&'static str>,
}

fn platform_codex_install_command(
    npm_program: Option<PathBuf>,
) -> Result<CodexInstallCommand, String> {
    #[cfg(target_os = "windows")]
    {
        let _ = npm_program;
        Ok(CodexInstallCommand {
            program: PathBuf::from("winget"),
            args: vec![
                "install",
                "--id",
                "9PLM9XGG6VKS",
                "-s",
                "msstore",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ],
        })
    }

    #[cfg(not(target_os = "windows"))]
    {
        let program = npm_program.ok_or_else(|| "npm was not found on PATH".to_string())?;
        Ok(CodexInstallCommand {
            program,
            args: vec!["install", "--global", "@openai/codex"],
        })
    }
}

#[cfg(not(target_os = "windows"))]
fn npm_from_path() -> Option<PathBuf> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .map(|directory| directory.join("npm"))
        .find(|candidate| candidate.is_file())
}

#[cfg(target_os = "windows")]
fn npm_from_path() -> Option<PathBuf> {
    None
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

// Stable provider-neutral installer events. Consumers distinguish concurrent providers via
// payload.runtime and stdout/stderr via payload.stream; installer arguments are never emitted.
const RUNTIME_INSTALL_OUTPUT_EVENT: &str = "runtime-install-output";
const RUNTIME_INSTALL_COMPLETE_EVENT: &str = "runtime-install-complete";
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

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

fn redact_after_marker(value: &str, marker: &str) -> String {
    let mut redacted = String::with_capacity(value.len());
    let mut cursor = 0;

    while let Some(relative) =
        find_ascii_case_insensitive(&value.as_bytes()[cursor..], marker.as_bytes())
    {
        let marker_start = cursor + relative;
        let marker_end = marker_start + marker.len();
        redacted.push_str(&value[cursor..marker_end]);

        let whitespace_len = value[marker_end..]
            .char_indices()
            .take_while(|(_, character)| character.is_whitespace())
            .last()
            .map(|(offset, character)| offset + character.len_utf8())
            .unwrap_or(0);
        let secret_start = marker_end + whitespace_len;
        redacted.push_str(&value[marker_end..secret_start]);

        let secret_len = value[secret_start..]
            .char_indices()
            .find(|(_, character)| {
                character.is_whitespace()
                    || matches!(character, '&' | ';' | '"' | '\'' | '<' | '>' | ')' | ']')
            })
            .map(|(offset, _)| offset)
            .unwrap_or_else(|| value.len() - secret_start);

        if secret_len == 0 {
            cursor = secret_start;
            if cursor == value.len() {
                break;
            }
            continue;
        }

        redacted.push_str("[REDACTED]");
        cursor = secret_start + secret_len;
    }

    redacted.push_str(&value[cursor..]);
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
    for marker in [
        "bearer ",
        "openai_api_key=",
        "anthropic_api_key=",
        "api_key=",
        "api-key=",
        "api key:",
        "api key=",
        "access_token=",
        "access-token=",
        "access-token ",
        "access token:",
        "x-amz-signature=",
        "x-amz-security-token=",
        "x-amz-credential=",
        "x-goog-signature=",
        "authorization=",
        "authorization:",
        "signature=",
        "token=",
        "sig=",
        "key=",
    ] {
        clean = redact_after_marker(&clean, marker);
    }
    redact_standalone_api_keys(&clean)
}

fn emit_install_output(window: &WebviewWindow, stream: RuntimeInstallStream, line: &str) {
    let _ = window.emit(
        RUNTIME_INSTALL_OUTPUT_EVENT,
        RuntimeInstallOutput {
            runtime: RuntimeKind::Codex,
            stream,
            line: sanitize_install_output(line),
        },
    );
}

async fn stream_installer_lines<R>(window: WebviewWindow, stream: RuntimeInstallStream, reader: R)
where
    R: AsyncBufRead + Unpin,
{
    let mut lines = reader.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        emit_install_output(&window, stream, &line);
    }
}

async fn install_codex_cli(window: WebviewWindow) -> Result<bool, String> {
    let spec = platform_codex_install_command(npm_from_path())?;
    let mut command = tokio::process::Command::new(&spec.program);
    command
        .args(&spec.args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.as_std_mut().creation_flags(0x0800_0000);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = format!("Codex installer could not be started: {error}");
            emit_install_output(&window, RuntimeInstallStream::Stderr, &message);
            let _ = window.emit(
                RUNTIME_INSTALL_COMPLETE_EVENT,
                RuntimeInstallCompletion {
                    runtime: RuntimeKind::Codex,
                    success: false,
                },
            );
            return Err(message);
        }
    };

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        return Err("Codex installer stdout was unavailable".into());
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill().await;
        return Err("Codex installer stderr was unavailable".into());
    };
    let stdout_task = tokio::spawn(stream_installer_lines(
        window.clone(),
        RuntimeInstallStream::Stdout,
        BufReader::new(stdout),
    ));
    let stderr_task = tokio::spawn(stream_installer_lines(
        window.clone(),
        RuntimeInstallStream::Stderr,
        BufReader::new(stderr),
    ));

    let status = match tokio::time::timeout(INSTALL_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => Some(status),
        Ok(Err(error)) => {
            emit_install_output(
                &window,
                RuntimeInstallStream::Stderr,
                &format!("Codex installer failed while waiting: {error}"),
            );
            None
        }
        Err(_) => {
            let _ = child.kill().await;
            emit_install_output(
                &window,
                RuntimeInstallStream::Stderr,
                "Codex installer timed out after 10 minutes.",
            );
            None
        }
    };

    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let mut success = status.is_some_and(|status| status.success());
    if success && codex::discovery::discover_codex_binary().await.is_err() {
        success = false;
        emit_install_output(
            &window,
            RuntimeInstallStream::Stderr,
            "Installer exited successfully, but no validated Codex CLI was found.",
        );
    } else if !success {
        emit_install_output(
            &window,
            RuntimeInstallStream::Status,
            "Codex installation did not complete successfully.",
        );
    }

    let _ = window.emit(
        RUNTIME_INSTALL_COMPLETE_EVENT,
        RuntimeInstallCompletion {
            runtime: RuntimeKind::Codex,
            success,
        },
    );
    Ok(success)
}

#[tauri::command]
pub async fn runtime_install(runtime: RuntimeKind, window: WebviewWindow) -> Result<bool, String> {
    match runtime {
        RuntimeKind::Claude => crate::claude::install_claude_cli(window).await,
        RuntimeKind::Codex => install_codex_cli(window).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::codex::discovery::CodexBinary;
    use std::path::PathBuf;

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

    #[test]
    fn platform_installer_uses_the_official_codex_command() {
        let spec = platform_codex_install_command(Some(PathBuf::from("/test/npm"))).unwrap();

        #[cfg(target_os = "windows")]
        {
            assert_eq!(spec.program, PathBuf::from("winget"));
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
}
