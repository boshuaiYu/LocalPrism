use super::crypto::{decode_jwt_payload, form_encode, pkce_challenge, random_hex};
use super::store::{load_oauth, save_oauth, OAuthKind};
use super::types::OAuthTokens;
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub const OPENAI_AUTH_ISSUER: &str = "https://auth.openai.com";
pub const OPENAI_CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const OPENAI_CODEX_API_ENDPOINT: &str = "https://chatgpt.com/backend-api/codex/responses";
pub const OPENAI_CODEX_MODELS_ENDPOINT: &str = "https://chatgpt.com/backend-api/codex/models";
pub const OPENAI_CODEX_CLIENT_VERSION: &str = "0.155.0";
pub const OPENAI_CODEX_ORIGINATOR: &str = "codex_cli_rs";
pub const OPENAI_CODEX_OAUTH_PORT: u16 = 1455;
pub const OPENAI_CODEX_USER_AGENT: &str = "codex-cli/0.155.0";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStart {
    pub auth_url: String,
    pub login_id: String,
}

pub struct LoginSession {
    #[allow(dead_code)]
    pub login_id: String,
    pub state: String,
    pub verifier: String,
    pub redirect_uri: String,
    pub listener: TcpListener,
}

pub async fn start_login_session() -> Result<(OAuthStart, LoginSession), String> {
    let listener = TcpListener::bind(("127.0.0.1", OPENAI_CODEX_OAUTH_PORT))
        .await
        .map_err(|err| {
            format!(
                "Port {OPENAI_CODEX_OAUTH_PORT} is already in use. Close the other process using it and try ChatGPT sign-in again: {err}"
            )
        })?;
    let redirect_uri = format!("http://localhost:{OPENAI_CODEX_OAUTH_PORT}/auth/callback");
    let state = random_hex(32);
    let verifier = random_hex(64);
    let challenge = pkce_challenge(&verifier);
    let login_id = random_hex(8);
    let auth_url = format!(
        "{OPENAI_AUTH_ISSUER}/oauth/authorize?{}",
        form_encode(&[
            ("response_type", "code"),
            ("client_id", OPENAI_CODEX_CLIENT_ID),
            ("redirect_uri", redirect_uri.as_str()),
            ("scope", "openid profile email offline_access"),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("id_token_add_organizations", "true"),
            ("codex_cli_simplified_flow", "true"),
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

pub async fn finish_login_session(session: LoginSession) -> Result<OAuthTokens, String> {
    let callback = accept_code(
        &session.listener,
        &session.state,
        Duration::from_secs(10 * 60),
    )
    .await?;
    exchange_code(&callback, &session.redirect_uri, &session.verifier).await
}

async fn accept_code(
    listener: &TcpListener,
    expected_state: &str,
    wait: Duration,
) -> Result<String, String> {
    let (mut stream, _) = tokio::time::timeout(wait, listener.accept())
        .await
        .map_err(|_| "Timed out waiting for the browser to finish sign-in".to_string())?
        .map_err(|err| format!("ChatGPT OAuth callback failed: {err}"))?;
    let mut buf = vec![0_u8; 8192];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|err| format!("Failed to read ChatGPT OAuth callback: {err}"))?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or_default();
    let query = path.split_once('?').map(|(_, query)| query).unwrap_or("");
    let params = parse_query(query);
    let body = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!doctype html><html><body><p>LocalPrism signed in with ChatGPT. You can close this tab.</p></body></html>";
    let _ = stream.write_all(body.as_bytes()).await;
    let _ = stream.shutdown().await;
    if let Some(error) = params.get("error") {
        return Err(format!("ChatGPT OAuth returned error: {error}"));
    }
    let code = params
        .get("code")
        .cloned()
        .ok_or_else(|| "ChatGPT OAuth callback missing code".to_string())?;
    let state = params.get("state").cloned().unwrap_or_default();
    if state != expected_state {
        return Err("ChatGPT OAuth state mismatch".into());
    }
    Ok(code)
}

fn parse_query(query: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        map.insert(percent_decode(key), percent_decode(value));
    }
    map
}

fn percent_decode(value: &str) -> String {
    let mut out = Vec::new();
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                if let Ok(byte) =
                    u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
                {
                    out.push(byte);
                    i += 3;
                } else {
                    out.push(b'%');
                    i += 1;
                }
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn exchange_code(
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<OAuthTokens, String> {
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .build()
        .map_err(|err| format!("Failed to build ChatGPT token client: {err}"))?;
    let body = form_encode(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", OPENAI_CODEX_CLIENT_ID),
        ("code_verifier", verifier),
    ]);
    let response = client
        .post(format!("{OPENAI_AUTH_ISSUER}/oauth/token"))
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("User-Agent", OPENAI_CODEX_USER_AGENT)
        .body(body)
        .send()
        .await
        .map_err(|err| format!("ChatGPT token exchange failed: {err}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("ChatGPT token response unread: {err}"))?;
    if !status.is_success() {
        return Err(format!("ChatGPT token exchange failed: {status}"));
    }
    parse_token_response(&text)
}

pub fn parse_token_response(body: &str) -> Result<OAuthTokens, String> {
    let value: Value =
        serde_json::from_str(body).map_err(|err| format!("ChatGPT token JSON invalid: {err}"))?;
    let access = value
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "ChatGPT token response missing access_token".to_string())?;
    let refresh = value
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let expires_in = value
        .get("expires_in")
        .and_then(Value::as_u64)
        .unwrap_or(3600);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?
        .as_millis() as i64;
    let claims = value
        .get("id_token")
        .and_then(Value::as_str)
        .and_then(decode_jwt_payload)
        .or_else(|| decode_jwt_payload(access));
    Ok(enrich_oauth_claims(OAuthTokens {
        access_token: access.to_string(),
        refresh_token: refresh,
        expires_at: now + (expires_in as i64) * 1000,
        account_id: jwt_account_id(claims.as_ref()),
        email: jwt_email(claims.as_ref()),
        subscription_type: jwt_plan(claims.as_ref()),
    }))
}

pub fn enrich_oauth_claims(mut tokens: OAuthTokens) -> OAuthTokens {
    let claims = decode_jwt_payload(&tokens.access_token);
    if tokens.account_id.as_deref().map(str::trim).unwrap_or("").is_empty() {
        tokens.account_id = jwt_account_id(claims.as_ref());
    }
    if tokens.email.as_deref().map(str::trim).unwrap_or("").is_empty() {
        tokens.email = jwt_email(claims.as_ref());
    }
    if tokens
        .subscription_type
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        tokens.subscription_type = jwt_plan(claims.as_ref());
    }
    tokens
}

fn jwt_account_id(claims: Option<&Value>) -> Option<String> {
    let claims = claims?;
    claims
        .get("chatgpt_account_id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            claims
                .pointer("/https://api.openai.com/auth/chatgpt_account_id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .filter(|value| !value.is_empty())
}

fn jwt_email(claims: Option<&Value>) -> Option<String> {
    let claims = claims?;
    claims
        .get("email")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            claims
                .pointer("/https://api.openai.com/profile/email")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
}

fn jwt_plan(claims: Option<&Value>) -> Option<String> {
    let claims = claims?;
    claims
        .get("chatgpt_plan_type")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            claims
                .pointer("/https://api.openai.com/auth/chatgpt_plan_type")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .filter(|value| !value.is_empty())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

pub async fn persist_tokens(tokens: OAuthTokens) -> Result<(), String> {
    save_oauth(OAuthKind::OpenAi, &tokens)
}

pub async fn ensure_fresh_tokens() -> Result<OAuthTokens, String> {
    let tokens = enrich_oauth_claims(
        load_oauth(OAuthKind::OpenAi)?
            .ok_or_else(|| "ChatGPT Official is not signed in".to_string())?,
    );
    let now = now_ms();
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

pub async fn refresh_tokens(refresh_token: &str) -> Result<OAuthTokens, String> {
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .build()
        .map_err(|err| format!("Failed to build ChatGPT refresh client: {err}"))?;
    let body = form_encode(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", OPENAI_CODEX_CLIENT_ID),
        ("scope", "openid profile email offline_access"),
    ]);
    let response = client
        .post(format!("{OPENAI_AUTH_ISSUER}/oauth/token"))
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("User-Agent", OPENAI_CODEX_USER_AGENT)
        .body(body)
        .send()
        .await
        .map_err(|err| format!("ChatGPT token refresh failed: {err}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("ChatGPT refresh response unread: {err}"))?;
    if !status.is_success() {
        return Err(format!("ChatGPT token refresh failed: {status}"));
    }
    let mut tokens = parse_token_response(&text)?;
    if tokens.refresh_token.is_none() {
        tokens.refresh_token = Some(refresh_token.to_string());
    }
    Ok(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::types::OAuthTokens;

    #[test]
    fn parses_chatgpt_token_without_jwt() {
        let tokens =
            parse_token_response(r#"{"access_token":"tok","refresh_token":"ref","expires_in":60}"#)
                .unwrap();
        assert_eq!(tokens.access_token, "tok");
        assert_eq!(tokens.refresh_token.as_deref(), Some("ref"));
    }

    #[test]
    fn refresh_keeps_previous_refresh_token_when_omitted() {
        let mut tokens =
            parse_token_response(r#"{"access_token":"next","expires_in":60}"#).unwrap();
        if tokens.refresh_token.is_none() {
            tokens.refresh_token = Some("old-refresh".into());
        }
        assert_eq!(tokens.refresh_token.as_deref(), Some("old-refresh"));
    }

    #[tokio::test]
    async fn ensure_fresh_keeps_unexpired_tokens() {
        let _guard = crate::providers::paths::lock_provider_env();
        let dir = tempfile::TempDir::new().unwrap();
        std::env::set_var("LOCALPRISM_PROVIDERS_DIR", dir.path());
        std::env::set_var(
            "LOCALPRISM_LEGACY_ANTHROPIC_AUTH",
            dir.path().join("missing.json"),
        );
        persist_tokens(OAuthTokens {
            access_token: "live".into(),
            refresh_token: Some("ref".into()),
            expires_at: 9_999_999_999_999,
            account_id: None,
            email: None,
            subscription_type: None,
        })
        .await
        .unwrap();
        let tokens = ensure_fresh_tokens().await.unwrap();
        assert_eq!(tokens.access_token, "live");
    }

    #[test]
    fn parse_token_response_reads_nested_account_and_plan() {
        let jwt = unsigned_jwt(
            r#"{"email":"a@b.c","https://api.openai.com/auth":{"chatgpt_account_id":"acc-1","chatgpt_plan_type":"pro"}}"#,
        );
        let tokens = parse_token_response(&format!(
            r#"{{"access_token":"{jwt}","refresh_token":"ref","expires_in":60}}"#
        ))
        .unwrap();
        assert_eq!(tokens.account_id.as_deref(), Some("acc-1"));
        assert_eq!(tokens.subscription_type.as_deref(), Some("pro"));
        assert_eq!(tokens.email.as_deref(), Some("a@b.c"));
    }

    fn unsigned_jwt(payload: &str) -> String {
        use base64::Engine;
        format!(
            "eyJhbGciOiJub25lIn0.{}.e30",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.as_bytes())
        )
    }
}
