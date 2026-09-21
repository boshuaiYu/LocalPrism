use std::collections::HashMap;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::time::timeout;

pub struct AuthCallback {
    pub code: String,
    pub state: String,
}

#[allow(dead_code)]
pub async fn listen_for_code(
    preferred_port: Option<u16>,
    expected_state: String,
    wait: Duration,
) -> Result<(String, AuthCallback), String> {
    let bind = match preferred_port {
        Some(port) => format!("127.0.0.1:{port}"),
        None => "127.0.0.1:0".to_string(),
    };
    let listener = match TcpListener::bind(&bind).await {
        Ok(listener) => listener,
        Err(_) if preferred_port.is_some() => TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|err| format!("Failed to start OAuth callback listener: {err}"))?,
        Err(err) => return Err(format!("Failed to start OAuth callback listener: {err}")),
    };
    let addr = listener
        .local_addr()
        .map_err(|err| format!("Failed to read OAuth callback address: {err}"))?;
    let redirect_uri = format!("http://127.0.0.1:{}/auth/callback", addr.port());
    let (tx, rx) = oneshot::channel();
    tokio::spawn(async move {
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut buf = vec![0_u8; 8192];
            if let Ok(n) = stream.read(&mut buf).await {
                let request = String::from_utf8_lossy(&buf[..n]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or_default();
                let query = path.split_once('?').map(|(_, query)| query).unwrap_or("");
                let params = parse_query(query);
                let body = if params.get("code").is_some() {
                    html_page("LocalPrism signed in. You can close this tab.")
                } else {
                    html_page("LocalPrism login failed. Return to the app and try again.")
                };
                let _ = stream.write_all(body.as_bytes()).await;
                let _ = stream.shutdown().await;
                let _ = tx.send(params);
            }
        }
    });

    let params = timeout(wait, rx)
        .await
        .map_err(|_| "Timed out waiting for the browser to finish sign-in".to_string())?
        .map_err(|_| "OAuth callback listener closed".to_string())?;
    if let Some(error) = params.get("error") {
        return Err(format!("OAuth provider returned error: {error}"));
    }
    let code = params
        .get("code")
        .cloned()
        .ok_or_else(|| "OAuth callback did not include an authorization code".to_string())?;
    let state = params.get("state").cloned().unwrap_or_default();
    if state != expected_state {
        return Err("OAuth state mismatch".into());
    }
    Ok((redirect_uri, AuthCallback { code, state }))
}

fn parse_query(query: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        map.insert(url_decode(key), url_decode(value));
    }
    map
}

fn url_decode(value: &str) -> String {
    let mut bytes = Vec::new();
    let chars: Vec<char> = value.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '+' => {
                bytes.push(b' ');
                i += 1;
            }
            '%' if i + 2 < chars.len() => {
                let hex = format!("{}{}", chars[i + 1], chars[i + 2]);
                if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                    bytes.push(byte);
                    i += 3;
                } else {
                    bytes.push(b'%');
                    i += 1;
                }
            }
            other => {
                let mut buf = [0; 4];
                bytes.extend_from_slice(other.encode_utf8(&mut buf).as_bytes());
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn html_page(message: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><html><body><p>{}</p></body></html>",
        message
    )
}
