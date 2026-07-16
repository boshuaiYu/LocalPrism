use super::sanitize_install_output;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch, Mutex};

const TERMINATE_WRITER_LOCK_TIMEOUT: Duration = Duration::from_millis(100);
const DEFAULT_FRAME_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RPC_FRAME_BYTES: usize = 4 * 1024 * 1024;
const RPC_ERROR_MESSAGE_LIMIT: usize = 4 * 1024;

pub type OutboundRequestId = u64;

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum RpcId {
    Number(u64),
    String(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum RpcInbound {
    Notification {
        method: String,
        params: Value,
    },
    ServerRequest {
        id: RpcId,
        method: String,
        params: Value,
    },
    Malformed {
        line: String,
        error: String,
    },
}

pub struct RpcClient {
    writer: Mutex<Box<dyn AsyncWrite + Unpin + Send>>,
    write_timeout: Duration,
    next_id: AtomicU64,
    pending: Mutex<HashMap<OutboundRequestId, oneshot::Sender<Result<Value, String>>>>,
    terminated: AtomicBool,
    transport_failure: watch::Sender<Option<String>>,
}

struct ClosedWriter;

impl AsyncWrite for ClosedWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        _context: &mut Context<'_>,
        _buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "Codex app-server transport is closed",
        )))
    }

    fn poll_flush(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl RpcClient {
    pub fn new<W>(writer: W) -> Self
    where
        W: AsyncWrite + Unpin + Send + 'static,
    {
        Self::new_with_write_timeout(writer, DEFAULT_FRAME_WRITE_TIMEOUT)
    }

    pub(crate) fn new_with_write_timeout<W>(writer: W, write_timeout: Duration) -> Self
    where
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (transport_failure, _) = watch::channel(None);
        Self {
            writer: Mutex::new(Box::new(writer)),
            write_timeout,
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            terminated: AtomicBool::new(false),
            transport_failure,
        }
    }

    pub(crate) fn subscribe_transport_failures(&self) -> watch::Receiver<Option<String>> {
        self.transport_failure.subscribe()
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout_duration: Duration,
    ) -> Result<Value, String> {
        self.ensure_active()?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        if let Err(error) = self.ensure_active() {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        let deadline = tokio::time::Instant::now() + timeout_duration;
        let mut bytes =
            match serde_json::to_vec(&json!({"id": id, "method": method, "params": params})) {
                Ok(bytes) => bytes,
                Err(error) => {
                    self.pending.lock().await.remove(&id);
                    return Err(format!(
                        "Failed to serialize Codex app-server frame: {error}"
                    ));
                }
            };
        bytes.push(b'\n');

        let mut writer = match tokio::time::timeout_at(deadline, self.writer.lock()).await {
            Ok(writer) => writer,
            Err(_) => {
                let error = format!("Codex app-server request `{method}` timed out");
                self.fail_transport("Codex app-server stdin writer timed out")
                    .await;
                return Err(error);
            }
        };
        if let Err(error) = self.ensure_active() {
            drop(writer);
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        let write_result = tokio::time::timeout_at(deadline, async {
            writer
                .write_all(&bytes)
                .await
                .map_err(|error| format!("Failed to write Codex app-server frame: {error}"))?;
            writer
                .flush()
                .await
                .map_err(|error| format!("Failed to flush Codex app-server frame: {error}"))
        })
        .await;
        match write_result {
            Ok(Ok(())) => drop(writer),
            Ok(Err(error)) => {
                poison_writer(&mut writer);
                drop(writer);
                self.fail_transport(&error).await;
                return Err(error);
            }
            Err(_) => {
                poison_writer(&mut writer);
                drop(writer);
                let error = format!("Codex app-server request `{method}` timed out");
                self.fail_transport("Codex app-server stdin write timed out")
                    .await;
                return Err(error);
            }
        }

        match tokio::time::timeout_at(deadline, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&id);
                Err(format!("Codex app-server request `{method}` was cancelled"))
            }
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("Codex app-server request `{method}` timed out"))
            }
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write_frame(&json!({"method": method, "params": params}))
            .await
    }

    pub async fn respond(&self, id: RpcId, result: Value) -> Result<(), String> {
        self.write_frame(&json!({"id": id, "result": result})).await
    }

    pub async fn respond_error(&self, id: RpcId, code: i64, message: &str) -> Result<(), String> {
        self.write_frame(&json!({
            "id": id,
            "error": {"code": code, "message": message},
        }))
        .await
    }

    pub async fn pending_len(&self) -> usize {
        self.pending.lock().await.len()
    }

    pub(crate) async fn terminate(&self, message: &str) {
        self.terminated.store(true, Ordering::Release);
        self.fail_pending(message).await;
        if let Ok(mut writer) =
            tokio::time::timeout(TERMINATE_WRITER_LOCK_TIMEOUT, self.writer.lock()).await
        {
            poison_writer(&mut writer);
        }
        self.fail_pending(message).await;
    }

    pub(crate) async fn fail_pending(&self, message: &str) {
        let pending = {
            let mut pending = self.pending.lock().await;
            pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        };
        for sender in pending {
            let _ = sender.send(Err(message.to_owned()));
        }
    }

    pub(crate) async fn read_loop<R>(
        self: Arc<Self>,
        reader: R,
        inbound: mpsc::Sender<RpcInbound>,
    ) -> Result<(), String>
    where
        R: AsyncRead + Unpin,
    {
        self.read_loop_with_frame_limit(reader, inbound, MAX_RPC_FRAME_BYTES)
            .await
    }

    async fn read_loop_with_frame_limit<R>(
        self: Arc<Self>,
        reader: R,
        inbound: mpsc::Sender<RpcInbound>,
        frame_limit: usize,
    ) -> Result<(), String>
    where
        R: AsyncRead + Unpin,
    {
        let mut reader = BufReader::new(reader);
        loop {
            match read_bounded_line(&mut reader, frame_limit).await {
                Ok(Some(line)) => {
                    if let Err(error) = self.handle_line(line, &inbound).await {
                        self.fail_pending(&error).await;
                        return Err(error);
                    }
                }
                Ok(None) => {
                    self.fail_pending("Codex app-server stdout closed").await;
                    return Ok(());
                }
                Err(error) => {
                    let message = format!("Failed to read Codex app-server stdout: {error}");
                    self.fail_pending(&message).await;
                    return Err(message);
                }
            }
        }
    }

    async fn handle_line(
        &self,
        line: String,
        inbound: &mpsc::Sender<RpcInbound>,
    ) -> Result<(), String> {
        let frame = match serde_json::from_str::<Value>(&line) {
            Ok(frame) => frame,
            Err(error) => {
                return send_inbound(
                    inbound,
                    RpcInbound::Malformed {
                        line,
                        error: error.to_string(),
                    },
                )
                .await;
            }
        };

        let Some(object) = frame.as_object() else {
            return send_inbound(
                inbound,
                RpcInbound::Malformed {
                    line,
                    error: "JSON-RPC frame must be an object".into(),
                },
            )
            .await;
        };

        if let Some(method) = object.get("method").and_then(Value::as_str) {
            let params = object.get("params").cloned().unwrap_or(Value::Null);
            let message = match object.get("id") {
                Some(id) => match serde_json::from_value::<RpcId>(id.clone()) {
                    Ok(id) => RpcInbound::ServerRequest {
                        id,
                        method: method.to_owned(),
                        params,
                    },
                    Err(error) => RpcInbound::Malformed {
                        line,
                        error: format!("Invalid JSON-RPC request id: {error}"),
                    },
                },
                None => RpcInbound::Notification {
                    method: method.to_owned(),
                    params,
                },
            };
            return send_inbound(inbound, message).await;
        }

        let Some(id_value) = object.get("id") else {
            return send_inbound(
                inbound,
                RpcInbound::Malformed {
                    line,
                    error: "JSON-RPC frame has neither method nor id".into(),
                },
            )
            .await;
        };
        let id = match serde_json::from_value::<RpcId>(id_value.clone()) {
            Ok(RpcId::Number(id)) => id,
            Ok(RpcId::String(_)) => {
                return send_inbound(
                    inbound,
                    RpcInbound::Malformed {
                        line,
                        error: "Codex response id must match a numeric client request id".into(),
                    },
                )
                .await;
            }
            Err(error) => {
                return send_inbound(
                    inbound,
                    RpcInbound::Malformed {
                        line,
                        error: format!("Invalid JSON-RPC response id: {error}"),
                    },
                )
                .await;
            }
        };

        let result = match (object.get("result"), object.get("error")) {
            (Some(result), None) => Ok(result.clone()),
            (None, Some(error)) => {
                let code = error.get("code").and_then(Value::as_i64);
                let message = error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown JSON-RPC error");
                let message = sanitize_untrusted_message(message);
                Err(match code {
                    Some(code) => format!("Codex app-server error {code}: {message}"),
                    None => format!("Codex app-server error: {message}"),
                })
            }
            (None, None) | (Some(_), Some(_)) => {
                return send_inbound(
                    inbound,
                    RpcInbound::Malformed {
                        line,
                        error: "JSON-RPC response must contain exactly one result or error".into(),
                    },
                )
                .await;
            }
        };
        let Some(sender) = self.pending.lock().await.remove(&id) else {
            return Ok(());
        };
        let _ = sender.send(result);
        Ok(())
    }

    async fn write_frame(&self, frame: &Value) -> Result<(), String> {
        self.ensure_active()?;
        let mut bytes = serde_json::to_vec(frame)
            .map_err(|error| format!("Failed to serialize Codex app-server frame: {error}"))?;
        bytes.push(b'\n');
        let deadline = tokio::time::Instant::now() + self.write_timeout;
        let mut writer = match tokio::time::timeout_at(deadline, self.writer.lock()).await {
            Ok(writer) => writer,
            Err(_) => {
                let error = "Codex app-server stdin writer timed out".to_string();
                self.fail_transport(&error).await;
                return Err(error);
            }
        };
        self.ensure_active()?;
        let result = tokio::time::timeout_at(deadline, async {
            writer
                .write_all(&bytes)
                .await
                .map_err(|error| format!("Failed to write Codex app-server frame: {error}"))?;
            writer
                .flush()
                .await
                .map_err(|error| format!("Failed to flush Codex app-server frame: {error}"))
        })
        .await;
        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => {
                poison_writer(&mut writer);
                drop(writer);
                self.fail_transport(&error).await;
                Err(error)
            }
            Err(_) => {
                poison_writer(&mut writer);
                drop(writer);
                let error = "Codex app-server stdin write timed out".to_string();
                self.fail_transport(&error).await;
                Err(error)
            }
        }
    }

    async fn fail_transport(&self, message: &str) {
        let message = sanitize_untrusted_message(message);
        if self
            .terminated
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            self.transport_failure.send_replace(Some(message.clone()));
        }
        self.fail_pending(&message).await;
    }

    fn ensure_active(&self) -> Result<(), String> {
        if self.terminated.load(Ordering::Acquire) {
            Err(self
                .transport_failure
                .borrow()
                .clone()
                .unwrap_or_else(|| "Codex app-server transport is closed".into()))
        } else {
            Ok(())
        }
    }
}

async fn send_inbound(
    inbound: &mpsc::Sender<RpcInbound>,
    message: RpcInbound,
) -> Result<(), String> {
    inbound
        .send(message)
        .await
        .map_err(|_| "Codex app-server inbound handler stopped unexpectedly".to_string())
}

async fn read_bounded_line<R>(reader: &mut R, limit: usize) -> Result<Option<String>, String>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::with_capacity(limit.min(8 * 1024));
    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|error| format!("Failed to read Codex app-server stdout: {error}"))?;
        if available.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return String::from_utf8(line)
                .map(Some)
                .map_err(|_| "Codex app-server stdout frame was not valid UTF-8".to_string());
        }

        let newline = available.iter().position(|byte| *byte == b'\n');
        let content_len = newline.unwrap_or(available.len());
        if line.len().saturating_add(content_len) > limit {
            return Err(format!(
                "Codex app-server stdout frame exceeded the {limit}-byte limit"
            ));
        }
        line.extend_from_slice(&available[..content_len]);
        let consumed = content_len + usize::from(newline.is_some());
        reader.consume(consumed);

        if newline.is_some() {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return String::from_utf8(line)
                .map(Some)
                .map_err(|_| "Codex app-server stdout frame was not valid UTF-8".to_string());
        }
    }
}

fn sanitize_untrusted_message(message: &str) -> String {
    let sanitized = sanitize_install_output(message);
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
    if single_line.len() <= RPC_ERROR_MESSAGE_LIMIT {
        return single_line;
    }
    let mut end = RPC_ERROR_MESSAGE_LIMIT;
    while !single_line.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &single_line[..end])
}

fn poison_writer(writer: &mut Box<dyn AsyncWrite + Unpin + Send>) {
    let transport = std::mem::replace(writer, Box::new(ClosedWriter));
    drop(transport);
}

#[cfg(test)]
mod tests {
    use super::{RpcClient, RpcId, RpcInbound};
    use serde_json::{json, Value};
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::Duration;
    use tokio::io::{duplex, split, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::sync::mpsc;

    struct PermanentlyBackpressuredWriter;

    impl tokio::io::AsyncWrite for PermanentlyBackpressuredWriter {
        fn poll_write(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
            _buffer: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            Poll::Pending
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<std::io::Result<()>> {
            Poll::Pending
        }

        fn poll_shutdown(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
        ) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn correlates_interleaved_frames_and_preserves_server_request_ids(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (client_io, server_io) = duplex(8 * 1024);
        let (client_read, client_write) = split(client_io);
        let (server_read, mut server_write) = split(server_io);
        let client = std::sync::Arc::new(RpcClient::new(client_write));
        let (inbound_tx, mut inbound_rx) = mpsc::channel(16);
        let reader = tokio::spawn(client.clone().read_loop(client_read, inbound_tx));

        let first_client = client.clone();
        let first = tokio::spawn(async move {
            first_client
                .request("account/read", json!({}), Duration::from_secs(1))
                .await
        });
        let second_client = client.clone();
        let second = tokio::spawn(async move {
            second_client
                .request("model/list", json!({"limit": 20}), Duration::from_secs(1))
                .await
        });

        let mut requests = BufReader::new(server_read).lines();
        let first_wire: Value = serde_json::from_str(
            &requests
                .next_line()
                .await?
                .ok_or("first request line missing")?,
        )?;
        let second_wire: Value = serde_json::from_str(
            &requests
                .next_line()
                .await?
                .ok_or("second request line missing")?,
        )?;
        let account_id = [&first_wire, &second_wire]
            .into_iter()
            .find(|frame| frame["method"] == "account/read")
            .and_then(|frame| frame["id"].as_u64())
            .ok_or("account request id missing")?;
        let model_id = [&first_wire, &second_wire]
            .into_iter()
            .find(|frame| frame["method"] == "model/list")
            .and_then(|frame| frame["id"].as_u64())
            .ok_or("model request id missing")?;

        let frames = [
            json!({"method":"account/updated","params":{"plan":"plus"}}),
            json!({"id":"approval-a","method":"item/commandExecution/requestApproval","params":{"command":"cargo test"}}),
            json!({"id":17,"method":"item/fileChange/requestApproval","params":{"path":"main.tex"}}),
            json!({"jsonrpc":"2.0","id":model_id,"result":{"data":[{"id":"gpt-5"}]}}),
            json!({"id":account_id,"result":{"requiresOpenaiAuth":true}}),
        ];
        for frame in frames {
            server_write.write_all(frame.to_string().as_bytes()).await?;
            server_write.write_all(b"\n").await?;
        }

        assert_eq!(
            inbound_rx.recv().await,
            Some(RpcInbound::Notification {
                method: "account/updated".into(),
                params: json!({"plan":"plus"}),
            })
        );
        assert_eq!(
            inbound_rx.recv().await,
            Some(RpcInbound::ServerRequest {
                id: RpcId::String("approval-a".into()),
                method: "item/commandExecution/requestApproval".into(),
                params: json!({"command":"cargo test"}),
            })
        );
        assert_eq!(
            inbound_rx.recv().await,
            Some(RpcInbound::ServerRequest {
                id: RpcId::Number(17),
                method: "item/fileChange/requestApproval".into(),
                params: json!({"path":"main.tex"}),
            })
        );

        assert_eq!(second.await??, json!({"data":[{"id":"gpt-5"}]}));
        let response = first.await??;
        assert_eq!(response["requiresOpenaiAuth"], true);
        assert_eq!(client.pending_len().await, 0);

        reader.abort();
        Ok(())
    }

    #[tokio::test]
    async fn malformed_line_is_reported_and_does_not_stop_the_reader(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (client_io, mut server_io) = duplex(1024);
        let (client_read, client_write) = split(client_io);
        let client = std::sync::Arc::new(RpcClient::new(client_write));
        let (inbound_tx, mut inbound_rx) = mpsc::channel(16);
        let reader = tokio::spawn(client.clone().read_loop(client_read, inbound_tx));

        server_io.write_all(b"{not-json}\n").await?;
        server_io
            .write_all(b"{\"method\":\"thread/started\",\"params\":{\"threadId\":\"t-1\"}}\n")
            .await?;

        match inbound_rx.recv().await {
            Some(RpcInbound::Malformed { line, error }) => {
                assert_eq!(line, "{not-json}");
                assert!(!error.is_empty());
            }
            other => return Err(format!("expected malformed frame, got {other:?}").into()),
        }
        assert_eq!(
            inbound_rx.recv().await,
            Some(RpcInbound::Notification {
                method: "thread/started".into(),
                params: json!({"threadId":"t-1"}),
            })
        );

        reader.abort();
        Ok(())
    }

    #[tokio::test]
    async fn id_only_response_is_malformed_and_cannot_fake_success(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (client_io, server_io) = duplex(2048);
        let (client_read, client_write) = split(client_io);
        let (server_read, mut server_write) = split(server_io);
        let client = std::sync::Arc::new(RpcClient::new(client_write));
        let (inbound_tx, mut inbound_rx) = mpsc::channel(16);
        let reader = tokio::spawn(client.clone().read_loop(client_read, inbound_tx));
        let request_client = client.clone();
        let request = tokio::spawn(async move {
            request_client
                .request("initialize", json!({}), Duration::from_secs(1))
                .await
        });

        let mut requests = BufReader::new(server_read).lines();
        let wire: Value =
            serde_json::from_str(&requests.next_line().await?.ok_or("request line missing")?)?;
        let id = wire["id"].as_u64().ok_or("request id missing")?;
        server_write
            .write_all(format!("{{\"id\":{id}}}\n").as_bytes())
            .await?;

        let malformed = tokio::time::timeout(Duration::from_millis(100), inbound_rx.recv())
            .await
            .map_err(|_| "id-only response was incorrectly consumed as success")?;
        match malformed {
            Some(RpcInbound::Malformed { error, .. }) => {
                assert!(error.contains("result or error"));
            }
            other => return Err(format!("expected malformed response, got {other:?}").into()),
        }
        assert_eq!(client.pending_len().await, 1);

        server_write
            .write_all(format!("{{\"id\":{id},\"result\":{{\"ready\":true}}}}\n").as_bytes())
            .await?;
        assert_eq!(request.await??, json!({"ready":true}));
        assert_eq!(client.pending_len().await, 0);

        reader.abort();
        Ok(())
    }

    #[tokio::test]
    async fn timed_out_request_is_removed_from_pending_map(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (client_io, server_io) = duplex(1024);
        let (_client_read, client_write) = split(client_io);
        let (server_read, _server_write) = split(server_io);
        let client = RpcClient::new(client_write);
        let server = tokio::spawn(async move {
            let mut lines = BufReader::new(server_read).lines();
            lines.next_line().await
        });

        let error = client
            .request("account/read", json!({}), Duration::from_millis(20))
            .await
            .expect_err("request should time out");

        assert!(error.contains("timed out"));
        let line = server.await??;
        assert!(line.is_some());
        assert_eq!(client.pending_len().await, 0);
        Ok(())
    }

    #[tokio::test]
    async fn request_deadline_includes_a_backpressured_write(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (client_io, mut server_io) = duplex(64);
        let client = RpcClient::new(client_io);

        let result = tokio::time::timeout(
            Duration::from_millis(100),
            client.request(
                "turn/start",
                json!({"payload": "x".repeat(128 * 1024)}),
                Duration::from_millis(20),
            ),
        )
        .await
        .map_err(|_| "request deadline did not include its backpressured write")?;

        let error = result.expect_err("backpressured request should time out");
        assert!(error.contains("timed out"));
        assert_eq!(client.pending_len().await, 0);

        let second_error = client
            .request("account/read", json!({}), Duration::from_millis(20))
            .await
            .expect_err("a partially written transport must be poisoned");
        assert!(second_error.contains("write"));
        let mut captured = Vec::new();
        tokio::time::timeout(
            Duration::from_millis(100),
            server_io.read_to_end(&mut captured),
        )
        .await
        .map_err(|_| "timed-out partial writer stayed open and reusable")??;
        let captured = String::from_utf8_lossy(&captured);
        assert!(!captured.contains("account/read"));
        assert!(!captured.ends_with('\n'));
        Ok(())
    }

    #[tokio::test]
    async fn write_frame_timeout_reports_transport_failure_without_waiting_forever(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let client = RpcClient::new_with_write_timeout(
            PermanentlyBackpressuredWriter,
            Duration::from_millis(20),
        );
        let mut failures = client.subscribe_transport_failures();

        let result = tokio::time::timeout(
            Duration::from_millis(100),
            client.respond(RpcId::Number(7), json!({"decision":"decline"})),
        )
        .await
        .map_err(|_| "approval response write remained unbounded")?;

        assert!(result
            .expect_err("backpressured write unexpectedly succeeded")
            .contains("timed out"));
        tokio::time::timeout(Duration::from_millis(100), failures.changed())
            .await
            .map_err(|_| "transport failure was not published")??;
        let failure = failures
            .borrow()
            .clone()
            .ok_or("transport failure message missing")?;
        assert!(failure.contains("stdin"));
        Ok(())
    }

    #[tokio::test]
    async fn oversized_no_newline_frame_is_rejected_at_the_configured_limit(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let client = std::sync::Arc::new(RpcClient::new(tokio::io::sink()));
        let (inbound_tx, _inbound_rx) = mpsc::channel(1);

        let error = client
            .read_loop_with_frame_limit(std::io::Cursor::new(vec![b'x'; 65]), inbound_tx, 64)
            .await
            .expect_err("oversized no-newline frame was accepted");

        assert!(error.contains("64"));
        assert!(!error.contains(&"x".repeat(32)));
        Ok(())
    }

    #[tokio::test]
    async fn bounded_inbound_channel_applies_backpressure_instead_of_growing_unbounded(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let input = concat!(
            "{\"method\":\"first\",\"params\":{}}\n",
            "{\"method\":\"second\",\"params\":{}}\n"
        );
        let client = std::sync::Arc::new(RpcClient::new(tokio::io::sink()));
        let (inbound_tx, mut inbound_rx) = mpsc::channel(1);
        let reader = tokio::spawn(client.read_loop(std::io::Cursor::new(input), inbound_tx));

        tokio::task::yield_now().await;
        assert!(
            !reader.is_finished(),
            "full inbound queue did not backpressure the reader"
        );
        assert!(matches!(
            inbound_rx.recv().await,
            Some(RpcInbound::Notification { method, .. }) if method == "first"
        ));
        assert!(matches!(
            inbound_rx.recv().await,
            Some(RpcInbound::Notification { method, .. }) if method == "second"
        ));
        reader.await??;
        Ok(())
    }

    #[tokio::test]
    async fn server_error_messages_are_redacted_bounded_and_single_line(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (client_io, server_io) = duplex(16 * 1024);
        let (client_read, client_write) = split(client_io);
        let (server_read, mut server_write) = split(server_io);
        let client = std::sync::Arc::new(RpcClient::new(client_write));
        let (inbound_tx, _inbound_rx) = mpsc::channel(4);
        let reader = tokio::spawn(client.clone().read_loop(client_read, inbound_tx));
        let request_client = client.clone();
        let request = tokio::spawn(async move {
            request_client
                .request("account/read", json!({}), Duration::from_secs(1))
                .await
        });

        let mut requests = BufReader::new(server_read).lines();
        let wire: Value =
            serde_json::from_str(&requests.next_line().await?.ok_or("request line missing")?)?;
        let id = wire["id"].as_u64().ok_or("request id missing")?;
        let secret = "rpc-secret-should-never-escape";
        let message = format!(
            "Authorization: Bearer {secret}\nOPENAI_API_KEY=sk-rpc-hidden {}",
            "z".repeat(8 * 1024)
        );
        server_write
            .write_all(
                format!(
                    "{}\n",
                    json!({"id":id,"error":{"code":-32000,"message":message}})
                )
                .as_bytes(),
            )
            .await?;

        let error = request
            .await?
            .expect_err("server error unexpectedly succeeded");
        assert!(error.contains("-32000"));
        assert!(!error.contains(secret));
        assert!(!error.contains("sk-rpc-hidden"));
        assert!(!error.contains(['\r', '\n']));
        assert!(error.len() <= 4 * 1024 + 128);

        reader.abort();
        Ok(())
    }

    #[tokio::test]
    async fn terminate_closes_transport_and_catches_a_request_registered_after_an_earlier_fail(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (client_io, _server_io) = duplex(1024);
        let client = std::sync::Arc::new(RpcClient::new(client_io));
        let writer_guard = client.writer.lock().await;
        client.fail_pending("first failure").await;

        let request_client = client.clone();
        let request = tokio::spawn(async move {
            request_client
                .request("turn/start", json!({}), Duration::from_secs(60))
                .await
        });
        tokio::time::timeout(Duration::from_millis(100), async {
            while client.pending_len().await != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .map_err(|_| "late request never registered")?;

        let terminate_client = client.clone();
        let terminate = tokio::spawn(async move {
            terminate_client.terminate("transport stopped").await;
        });
        tokio::time::timeout(Duration::from_millis(100), async {
            while client.pending_len().await != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .map_err(|_| "termination waited for the writer lock before failing pending requests")?;
        tokio::time::timeout(Duration::from_millis(500), terminate)
            .await
            .map_err(|_| "transport termination remained blocked on the writer lock")??;
        drop(writer_guard);
        let result = tokio::time::timeout(Duration::from_millis(100), request)
            .await
            .map_err(|_| "late request survived transport termination")??;
        let error = result.expect_err("terminated request unexpectedly succeeded");
        assert!(error.contains("transport stopped") || error.contains("closed"));

        let post_termination = tokio::time::timeout(
            Duration::from_millis(100),
            client.request("account/read", json!({}), Duration::from_secs(60)),
        )
        .await
        .map_err(|_| "post-termination request was not rejected immediately")?;
        assert!(post_termination
            .expect_err("post-termination request unexpectedly succeeded")
            .contains("closed"));
        assert_eq!(client.pending_len().await, 0);
        Ok(())
    }

    #[tokio::test]
    async fn responses_and_errors_are_one_compact_json_line_and_keep_id_type(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (client_io, server_io) = duplex(2048);
        let (_client_read, client_write) = split(client_io);
        let (server_read, _server_write) = split(server_io);
        let client = RpcClient::new(client_write);
        let mut lines = BufReader::new(server_read).lines();

        client
            .respond(
                RpcId::String("approval-a".into()),
                json!({"decision":"decline"}),
            )
            .await?;
        client
            .respond_error(RpcId::Number(23), -32601, "method not found")
            .await?;

        let response = lines.next_line().await?.ok_or("response missing")?;
        let error = lines.next_line().await?.ok_or("error response missing")?;
        assert_eq!(
            response,
            "{\"id\":\"approval-a\",\"result\":{\"decision\":\"decline\"}}"
        );
        assert_eq!(
            error,
            "{\"error\":{\"code\":-32601,\"message\":\"method not found\"},\"id\":23}"
        );
        Ok(())
    }
}
