use super::crypto::{form_encode, pkce_challenge, random_hex};
use super::store::{save_oauth, OAuthKind};
use super::types::OAuthTokens;
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
pub const CLAUDE_AUTHORIZE_URL: &str = "https://claude.com/cai/oauth/authorize";
pub const CLAUDE_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
pub const CLAUDE_SCOPES: &str = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload org:create_api_key";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStart {
    pub auth_url: String,
    pub login_id: String,
}

pub async fn start_login_session() -> Result<(OAuthStart, LoginSession), String> {
    let state = random_hex(16);
    let verifier = random_hex(32);
    let challenge = pkce_challenge(&verifier);
    let login_id = random_hex(8);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|err| format!("Failed to start Claude OAuth listener: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("Failed to read Claude OAuth port: {err}"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/auth/callback");
    let auth_url = format!(
        "{}?{}",
        CLAUDE_AUTHORIZE_URL,
        form_encode(&[
            ("response_type", "code"),
            ("client_id", CLAUDE_CLIENT_ID),
            ("redirect_uri", redirect_uri.as_str()),
            ("scope", CLAUDE_SCOPES),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("state", state.as_str()),
        ])
    );
    Ok((
        OAuthStart {
            auth_url,
            login_id: login_id.clone(),
        },
        LoginSession {
            login_id,
            state,
            verifier,
            redirect_uri,
            listener,
        },
    ))
}

pub struct LoginSession {
    #[allow(dead_code)]
    pub login_id: String,
    pub state: String,
    pub verifier: String,
    pub redirect_uri: String,
    pub listener: tokio::net::TcpListener,
}

pub async fn finish_login_session(session: LoginSession) -> Result<OAuthTokens, String> {
    let expected = session.state.clone();
    let (redirect_from_listener, callback) = accept_on_listener(
        session.listener,
        expected,
        Duration::from_secs(10 * 60),
        session.redirect_uri.clone(),
    )
    .await?;
    let _ = redirect_from_listener;
    exchange_claude_code(&callback.code, &session.redirect_uri, &session.verifier).await
}

async fn accept_on_listener(
    listener: tokio::net::TcpListener,
    expected_state: String,
    wait: Duration,
    redirect_uri: String,
) -> Result<(String, super::oauth_listen::AuthCallback), String> {
    drop(redirect_uri);
    // Reuse the shared parser by temporarily not using listen_for_code's bind.
    // Accept one connection with timeout.
    let (mut stream, _) = tokio::time::timeout(wait, listener.accept())
        .await
        .map_err(|_| "Timed out waiting for the browser to finish sign-in".to_string())?
        .map_err(|err| format!("OAuth callback failed: {err}"))?;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut buf = vec![0_u8; 8192];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|err| format!("Failed to read OAuth callback: {err}"))?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or_default();
    let query = path.split_once('?').map(|(_, query)| query).unwrap_or("");
    let mut params = std::collections::HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        params.insert(
            super::crypto::url_encode(key),
            value.replace("%2F", "/").replace("%3D", "="),
        );
        // Store raw percent-decoded via the shared helper by reconstructing.
        let _ = key;
    }
    // Decode properly using listen helper logic inline.
    params = decode_query(query);
    let body = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><html><body><p>LocalPrism signed in. You can close this tab.</p></body></html>";
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.shutdown().await;
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
    Ok((
        String::new(),
        super::oauth_listen::AuthCallback { code, state },
    ))
}

fn decode_query(query: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        map.insert(decode_component(key), decode_component(value));
    }
    map
}

fn decode_component(value: &str) -> String {
    let mut out = String::new();
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                if let Ok(byte) = u8::from_str_radix(&value[i + 1..i + 3], 16) {
                    out.push(byte as char);
                    i += 3;
                } else {
                    out.push('%');
                    i += 1;
                }
            }
            c => {
                out.push(c as char);
                i += 1;
            }
        }
    }
    out
}

pub async fn exchange_claude_code(
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<OAuthTokens, String> {
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .build()
        .map_err(|err| format!("Failed to build Claude token client: {err}"))?;
    let response = client
        .post(CLAUDE_TOKEN_URL)
        .header("Content-Type", "application/json")
        .header("anthropic-beta", "oauth-2025-04-20")
        .json(&serde_json::json!({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": CLAUDE_CLIENT_ID,
            "code_verifier": verifier,
        }))
        .send()
        .await
        .map_err(|err| format!("Claude token exchange failed: {err}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Claude token response unread: {err}"))?;
    if !status.is_success() {
        return Err(format!("Claude token exchange failed: {status}"));
    }
    parse_token_response(&body)
}

pub fn parse_token_response(body: &str) -> Result<OAuthTokens, String> {
    let value: Value =
        serde_json::from_str(body).map_err(|err| format!("Claude token JSON invalid: {err}"))?;
    let access = value
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "Claude token response missing access_token".to_string())?;
    let refresh = value
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let expires_in = value
        .get("expires_in")
        .and_then(Value::as_u64)
        .unwrap_or(3600);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?
        .as_millis() as i64;
    Ok(OAuthTokens {
        access_token: access.to_string(),
        refresh_token: refresh,
        expires_at: now + (expires_in as i64) * 1000,
        account_id: None,
        email: None,
        subscription_type: value
            .get("subscription_type")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    })
}

pub async fn persist_tokens(tokens: OAuthTokens) -> Result<(), String> {
    save_oauth(OAuthKind::Claude, &tokens)
}

pub async fn refresh_tokens(refresh_token: &str) -> Result<OAuthTokens, String> {
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .build()
        .map_err(|err| format!("Failed to build Claude refresh client: {err}"))?;
    let response = client
        .post(CLAUDE_TOKEN_URL)
        .header("Content-Type", "application/json")
        .header("anthropic-beta", "oauth-2025-04-20")
        .json(&serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CLAUDE_CLIENT_ID,
        }))
        .send()
        .await
        .map_err(|err| format!("Claude token refresh failed: {err}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("Claude refresh response unread: {err}"))?;
    if !status.is_success() {
        return Err(format!("Claude token refresh failed: {status}"));
    }
    let mut tokens = parse_token_response(&body)?;
    if tokens.refresh_token.is_none() {
        tokens.refresh_token = Some(refresh_token.to_string());
    }
    Ok(tokens)
}

pub async fn ensure_fresh_tokens() -> Result<OAuthTokens, String> {
    let tokens = super::store::load_oauth(OAuthKind::Claude)?
        .ok_or_else(|| "Claude Official is not signed in".to_string())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?
        .as_millis() as i64;
    if !tokens.is_expired_soon(now) {
        return Ok(tokens);
    }
    let Some(refresh) = tokens.refresh_token.clone() else {
        return Ok(tokens);
    };
    let next = refresh_tokens(&refresh).await?;
    persist_tokens(next.clone()).await?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_token_response() {
        let tokens = parse_token_response(
            r#"{"access_token":"a","refresh_token":"r","expires_in":120,"subscription_type":"pro"}"#,
        )
        .unwrap();
        assert_eq!(tokens.access_token, "a");
        assert_eq!(tokens.refresh_token.as_deref(), Some("r"));
        assert_eq!(tokens.subscription_type.as_deref(), Some("pro"));
        assert!(tokens.expires_at > 0);
    }
}
