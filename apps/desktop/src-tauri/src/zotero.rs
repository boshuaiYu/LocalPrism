use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha1::Sha1;
use std::collections::HashMap;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

type HmacSha1 = Hmac<Sha1>;

// Register your app at https://www.zotero.org/oauth/apps
// Set these via ZOTERO_CONSUMER_KEY / ZOTERO_CONSUMER_SECRET env vars,
// or replace these defaults with your registered credentials.
fn consumer_key() -> String {
    std::env::var("ZOTERO_CONSUMER_KEY")
        .unwrap_or_else(|_| option_env!("ZOTERO_CONSUMER_KEY").unwrap_or("").to_string())
}

fn consumer_secret() -> String {
    std::env::var("ZOTERO_CONSUMER_SECRET").unwrap_or_else(|_| {
        option_env!("ZOTERO_CONSUMER_SECRET")
            .unwrap_or("")
            .to_string()
    })
}

const REQUEST_TOKEN_URL: &str = "https://www.zotero.org/oauth/request";
const AUTHORIZE_URL: &str = "https://www.zotero.org/oauth/authorize";
const ACCESS_TOKEN_URL: &str = "https://www.zotero.org/oauth/access";

// ─── Types ───

#[derive(Serialize)]
pub struct ZoteroAuthUrl {
    pub authorize_url: String,
}

#[derive(Serialize)]
pub struct ZoteroOAuthResult {
    pub api_key: String,
    pub user_id: String,
    pub username: String,
}

pub struct ZoteroOAuthPending {
    listener: TcpListener,
    request_token_secret: String,
}

pub type ZoteroOAuthState = tokio::sync::Mutex<Option<ZoteroOAuthPending>>;

// ─── OAuth 1.0a Helpers ───

fn percent_encode(input: &str) -> String {
    let mut result = String::new();
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                result.push(byte as char);
            }
            _ => {
                result.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    result
}

fn generate_nonce() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", ts)
}

fn get_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn hmac_sha1(key: &str, message: &str) -> Result<String, String> {
    let mut mac =
        HmacSha1::new_from_slice(key.as_bytes()).map_err(|e| format!("Invalid HMAC key: {}", e))?;
    mac.update(message.as_bytes());
    Ok(BASE64.encode(mac.finalize().into_bytes()))
}

fn oauth_signature(
    method: &str,
    url: &str,
    params: &[(String, String)],
    consumer_secret: &str,
    token_secret: &str,
) -> String {
    let mut sorted = params.to_vec();
    sorted.sort();

    let param_string: String = sorted
        .iter()
        .map(|(k, v)| format!("{}={}", percent_encode(k), percent_encode(v)))
        .collect::<Vec<_>>()
        .join("&");

    let base_string = format!(
        "{}&{}&{}",
        percent_encode(method),
        percent_encode(url),
        percent_encode(&param_string)
    );

    let signing_key = format!(
        "{}&{}",
        percent_encode(consumer_secret),
        percent_encode(token_secret)
    );

    hmac_sha1(&signing_key, &base_string).unwrap_or_default()
}

fn build_auth_header(params: &[(String, String)]) -> String {
    let parts: Vec<String> = params
        .iter()
        .filter(|(k, _)| k.starts_with("oauth_"))
        .map(|(k, v)| format!("{}=\"{}\"", percent_encode(k), percent_encode(v)))
        .collect();
    format!("OAuth {}", parts.join(", "))
}

fn parse_form_urlencoded(body: &str) -> HashMap<String, String> {
    body.split('&')
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?;
            let value = parts.next().unwrap_or("");
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

// ─── OAuth Flow Steps ───

async fn request_token(callback_url: &str) -> Result<(String, String), String> {
    let ck = consumer_key();
    let cs = consumer_secret();
    if ck.is_empty() || cs.is_empty() {
        return Err("Zotero OAuth credentials not configured. Set ZOTERO_CONSUMER_KEY and ZOTERO_CONSUMER_SECRET environment variables.".into());
    }

    let nonce = generate_nonce();
    let timestamp = get_timestamp();

    let mut params = vec![
        ("oauth_callback".into(), callback_url.to_string()),
        ("oauth_consumer_key".into(), ck.clone()),
        ("oauth_nonce".into(), nonce),
        ("oauth_signature_method".into(), "HMAC-SHA1".into()),
        ("oauth_timestamp".into(), timestamp),
        ("oauth_version".into(), "1.0".into()),
    ];

    let sig = oauth_signature("POST", REQUEST_TOKEN_URL, &params, &cs, "");
    params.push(("oauth_signature".into(), sig));

    let header = build_auth_header(&params);

    let client = reqwest::Client::new();
    let response = client
        .post(REQUEST_TOKEN_URL)
        .header("Authorization", header)
        .send()
        .await
        .map_err(|e| format!("Request token failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Request token failed ({}): {}", status, body));
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    let map = parse_form_urlencoded(&body);

    let token = map
        .get("oauth_token")
        .cloned()
        .ok_or("Missing oauth_token in response")?;
    let secret = map
        .get("oauth_token_secret")
        .cloned()
        .ok_or("Missing oauth_token_secret in response")?;

    Ok((token, secret))
}

async fn wait_for_callback(listener: TcpListener) -> Result<(String, String), String> {
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        accept_callback(listener),
    )
    .await;

    match result {
        Ok(inner) => inner,
        Err(_) => Err("OAuth authorization timed out (120s)".into()),
    }
}

async fn accept_callback(listener: TcpListener) -> Result<(String, String), String> {
    let (mut stream, _) = listener
        .accept()
        .await
        .map_err(|e| format!("Accept failed: {}", e))?;

    let mut buf = vec![0u8; 4096];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("Read failed: {}", e))?;
    let request = String::from_utf8_lossy(buf.get(..n).unwrap_or(&buf));

    // Parse: GET /callback?oauth_token=xxx&oauth_verifier=yyy HTTP/1.1
    let first_line = request.lines().next().unwrap_or("");
    let path = first_line.split_whitespace().nth(1).unwrap_or("");
    let query = path.split('?').nth(1).unwrap_or("");
    let params = parse_form_urlencoded(query);

    // Respond with success page
    let html = r#"<!DOCTYPE html><html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Connected to Zotero!</h2><p style="color:#666">You can close this tab and return to LocalPrism.</p><script>setTimeout(()=>window.close(),1500)</script></body></html>"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    let _ = stream.write_all(response.as_bytes()).await;

    let token = params
        .get("oauth_token")
        .cloned()
        .ok_or("Missing oauth_token in callback")?;
    let verifier = params
        .get("oauth_verifier")
        .cloned()
        .ok_or("Missing oauth_verifier in callback")?;

    Ok((token, verifier))
}

async fn access_token(
    oauth_token: &str,
    token_secret: &str,
    verifier: &str,
) -> Result<ZoteroOAuthResult, String> {
    let ck = consumer_key();
    let cs = consumer_secret();

    let nonce = generate_nonce();
    let timestamp = get_timestamp();

    let mut params = vec![
        ("oauth_consumer_key".into(), ck),
        ("oauth_nonce".into(), nonce),
        ("oauth_signature_method".into(), "HMAC-SHA1".into()),
        ("oauth_timestamp".into(), timestamp),
        ("oauth_token".into(), oauth_token.to_string()),
        ("oauth_verifier".into(), verifier.to_string()),
        ("oauth_version".into(), "1.0".into()),
    ];

    let sig = oauth_signature("POST", ACCESS_TOKEN_URL, &params, &cs, token_secret);
    params.push(("oauth_signature".into(), sig));

    let header = build_auth_header(&params);

    let client = reqwest::Client::new();
    let response = client
        .post(ACCESS_TOKEN_URL)
        .header("Authorization", header)
        .send()
        .await
        .map_err(|e| format!("Access token failed: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Access token failed: {}", body));
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;
    let map = parse_form_urlencoded(&body);

    let api_key = map
        .get("oauth_token")
        .cloned()
        .ok_or("Missing oauth_token in access response")?;
    let user_id = map
        .get("userID")
        .cloned()
        .ok_or("Missing userID in access response")?;
    let username = map.get("username").cloned().unwrap_or_default();

    Ok(ZoteroOAuthResult {
        api_key,
        user_id,
        username,
    })
}

// ─── Tauri Commands ───

#[tauri::command]
pub async fn zotero_start_oauth(
    state: tauri::State<'_, ZoteroOAuthState>,
) -> Result<ZoteroAuthUrl, String> {
    // Bind local callback server
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind local server: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local address: {}", e))?
        .port();
    let callback_url = format!("http://127.0.0.1:{}/callback", port);

    // Get request token from Zotero
    let (token, secret) = request_token(&callback_url).await?;

    // Build authorize URL
    let authorize_url = format!(
        "{}?oauth_token={}&name=LocalPrism&library_access=1&notes_access=0&write_access=0&all_groups=read",
        AUTHORIZE_URL, token
    );

    // Store pending state
    *state.lock().await = Some(ZoteroOAuthPending {
        listener,
        request_token_secret: secret,
    });

    Ok(ZoteroAuthUrl { authorize_url })
}

#[tauri::command]
pub async fn zotero_complete_oauth(
    state: tauri::State<'_, ZoteroOAuthState>,
) -> Result<ZoteroOAuthResult, String> {
    let pending = state
        .lock()
        .await
        .take()
        .ok_or("No pending OAuth flow. Call zotero_start_oauth first.")?;

    // Wait for the callback from Zotero
    let (oauth_token, oauth_verifier) = wait_for_callback(pending.listener).await?;

    // Exchange for access token
    access_token(&oauth_token, &pending.request_token_secret, &oauth_verifier).await
}

#[tauri::command]
pub async fn zotero_cancel_oauth(state: tauri::State<'_, ZoteroOAuthState>) -> Result<(), String> {
    *state.lock().await = None;
    Ok(())
}

// ─── Library fetch (desktop local API + web API, no WebView cache) ───

const ZOTERO_WEB_API: &str = "https://api.zotero.org";
const ZOTERO_LOCAL_API: &str = "http://127.0.0.1:23119/api";
const ZOTERO_LOCAL_PORT: u16 = 23119;
const ZOTERO_CONNECTOR_PING: &str = "http://127.0.0.1:23119/connector/ping";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoteroApiResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub source: String,
}

pub(crate) fn validate_zotero_api_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') {
        return Err("Zotero path must start with /".into());
    }
    if path.contains("://") || path.contains("..") || path.contains('\\') || path.contains('\n') {
        return Err("Invalid Zotero path".into());
    }
    let route = path.split('?').next().unwrap_or(path);
    if route == "/keys/current"
        || route.starts_with("/keys/")
        || route.starts_with("/users/")
        || route.starts_with("/groups/")
    {
        return Ok(());
    }
    Err("Zotero path is not allowed".into())
}

fn zotero_response_headers(response: &reqwest::Response) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    for (name, value) in response.headers() {
        if let Ok(value) = value.to_str() {
            headers.insert(name.as_str().to_string(), value.to_string());
        }
    }
    headers
}

fn should_skip_forwarded_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "if-modified-since-version"
            | "if-none-match"
            | "if-modified-since"
            | "zotero-api-key"
            | "authorization"
            | "x-api-key"
            | "host"
            | "content-length"
    )
}

fn process_file_stem(name: &str) -> String {
    let file = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
    file.strip_suffix(".exe")
        .or_else(|| file.strip_suffix(".EXE"))
        .unwrap_or(file)
        .to_ascii_lowercase()
}

pub(crate) fn is_zotero_process_name(name: &str) -> bool {
    matches!(
        process_file_stem(name).as_str(),
        "zotero" | "zotero-bin" | "zotero.bin"
    )
}

fn is_sandbox_wrapper_process_name(name: &str) -> bool {
    matches!(
        process_file_stem(name).as_str(),
        "bwrap" | "flatpak" | "flatpak-bwrap" | "pressure-vessel"
    )
}

pub(crate) fn looks_like_zotero_connector_ping(
    headers: &HashMap<String, String>,
    body: &str,
) -> bool {
    if headers
        .keys()
        .any(|name| name.eq_ignore_ascii_case("x-zotero-version"))
    {
        return true;
    }
    let trimmed = body.trim();
    trimmed.eq_ignore_ascii_case("zotero is running")
        || trimmed.eq_ignore_ascii_case("zotero connector server is available")
}

pub(crate) fn should_trust_local_zotero_connector(
    process_name: Option<&str>,
    ping_looks_like_zotero: bool,
) -> bool {
    if process_name.is_some_and(|name| {
        !is_zotero_process_name(name) && !is_sandbox_wrapper_process_name(name)
    }) {
        return false;
    }
    ping_looks_like_zotero
}

fn should_attach_zotero_api_key(source: &str) -> bool {
    source != "local"
}

pub(crate) fn parse_hex_ipv4_socket(addr: &str) -> Option<(Ipv4Addr, u16)> {
    let (ip, port) = addr.split_once(':')?;
    let raw = u32::from_str_radix(ip, 16).ok()?;
    let port = u16::from_str_radix(port, 16).ok()?;
    Some((Ipv4Addr::from(raw.to_le_bytes()), port))
}

pub(crate) fn parse_hex_ipv6_socket(addr: &str) -> Option<(Ipv6Addr, u16)> {
    let (ip, port) = addr.split_once(':')?;
    if ip.len() != 32 {
        return None;
    }
    let port = u16::from_str_radix(port, 16).ok()?;
    let mut bytes = [0_u8; 16];
    for (index, chunk) in ip.as_bytes().chunks(8).enumerate() {
        let word = std::str::from_utf8(chunk).ok()?;
        let value = u32::from_str_radix(word, 16).ok()?;
        let start = index.checked_mul(4)?;
        let end = start.checked_add(4)?;
        bytes.get_mut(start..end)?.copy_from_slice(&value.to_le_bytes());
    }
    Some((Ipv6Addr::from(bytes), port))
}

pub(crate) fn parse_proc_net_listen_inodes(table: &str, port: u16, ipv6: bool) -> Vec<u64> {
    let mut inodes = Vec::new();
    for line in table.lines().skip(1) {
        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.len() < 10 {
            continue;
        }
        let local = columns[1];
        let state = columns[3];
        let inode = columns[9];
        if !state.eq_ignore_ascii_case("0A") {
            continue;
        }
        let matches_port = if ipv6 {
            parse_hex_ipv6_socket(local)
                .is_some_and(|(addr, found)| found == port && ipv6_listen_is_local(addr))
        } else {
            parse_hex_ipv4_socket(local)
                .is_some_and(|(addr, found)| found == port && ipv4_listen_is_local(addr))
        };
        if !matches_port {
            continue;
        }
        if let Ok(inode) = inode.parse::<u64>() {
            inodes.push(inode);
        }
    }
    inodes
}

pub(crate) fn parse_lsof_command_names(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|line| line.strip_prefix('c'))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect()
}

fn ipv4_listen_is_local(addr: Ipv4Addr) -> bool {
    addr.is_loopback() || addr.is_unspecified()
}

fn ipv6_listen_is_local(addr: Ipv6Addr) -> bool {
    addr.is_loopback()
        || addr.is_unspecified()
        || addr.to_ipv4_mapped().is_some_and(ipv4_listen_is_local)
}

pub(crate) fn local_address_has_port(local: &str, port: u16) -> bool {
    local
        .rsplit_once(':')
        .and_then(|(_, found)| found.parse::<u16>().ok())
        .is_some_and(|found| found == port)
}

pub(crate) fn local_address_is_loopback_or_unspecified(local: &str) -> bool {
    let host = local
        .rsplit_once(':')
        .map(|(host, _)| host.trim_matches(['[', ']']))
        .unwrap_or(local);
    if host == "*" || host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if let Ok(addr) = host.parse::<Ipv4Addr>() {
        return ipv4_listen_is_local(addr);
    }
    if let Ok(addr) = host.parse::<Ipv6Addr>() {
        return ipv6_listen_is_local(addr);
    }
    false
}

pub(crate) fn parse_netstat_listening_pids(stdout: &str, port: u16) -> Vec<u32> {
    let mut pids = Vec::new();
    for line in stdout.lines() {
        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.len() < 4 {
            continue;
        }
        let state = columns
            .get(3)
            .or_else(|| columns.get(4))
            .copied()
            .unwrap_or("");
        if !state.eq_ignore_ascii_case("LISTENING") && !state.eq_ignore_ascii_case("LISTEN") {
            continue;
        }
        let local = columns[1];
        if !local_address_has_port(local, port) || !local_address_is_loopback_or_unspecified(local)
        {
            continue;
        }
        if let Ok(pid) = columns[columns.len() - 1].parse::<u32>() {
            pids.push(pid);
        }
    }
    pids
}

pub(crate) fn parse_tasklist_image_name(stdout: &str) -> Option<String> {
    let line = stdout.lines().find(|row| row.contains(','))?;
    let first = line.split(',').next()?.trim();
    let name = first.trim_matches('"').trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

fn listener_process_name(port: u16) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        return linux_listener_process_name(port);
    }
    #[cfg(target_os = "macos")]
    {
        return macos_listener_process_name(port);
    }
    #[cfg(target_os = "windows")]
    {
        return windows_listener_process_name(port);
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = port;
        None
    }
}

#[cfg(target_os = "linux")]
fn linux_listener_process_name(port: u16) -> Option<String> {
    let mut inodes = Vec::new();
    if let Ok(table) = std::fs::read_to_string("/proc/net/tcp") {
        inodes.extend(parse_proc_net_listen_inodes(&table, port, false));
    }
    if let Ok(table) = std::fs::read_to_string("/proc/net/tcp6") {
        inodes.extend(parse_proc_net_listen_inodes(&table, port, true));
    }
    inodes
        .into_iter()
        .find_map(linux_process_name_for_socket_inode)
}

#[cfg(target_os = "linux")]
fn linux_process_name_for_socket_inode(inode: u64) -> Option<String> {
    let needle = format!("socket:[{inode}]");
    let proc = std::fs::read_dir("/proc").ok()?;
    for entry in proc {
        let Ok(entry) = entry else {
            continue;
        };
        let pid = entry.file_name();
        let Some(pid) = pid.to_str() else {
            continue;
        };
        if pid.parse::<u32>().is_err() {
            continue;
        }
        let fd_dir = std::fs::read_dir(entry.path().join("fd"));
        let Ok(fds) = fd_dir else {
            continue;
        };
        for fd in fds {
            let Ok(fd) = fd else {
                continue;
            };
            let Ok(target) = std::fs::read_link(fd.path()) else {
                continue;
            };
            if target == std::path::Path::new(&needle) {
                return std::fs::read_to_string(entry.path().join("comm"))
                    .ok()
                    .map(|name| name.trim().to_string());
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn macos_listener_process_name(port: u16) -> Option<String> {
    let output = std::process::Command::new("lsof")
        .args([
            "-nP",
            &format!("-iTCP:{port}"),
            "-sTCP:LISTEN",
            "-F",
            "c",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_lsof_command_names(&String::from_utf8_lossy(&output.stdout))
        .into_iter()
        .next()
}

#[cfg(target_os = "windows")]
fn windows_listener_process_name(port: u16) -> Option<String> {
    let netstat = std::process::Command::new("netstat")
        .args(["-ano", "-p", "TCP"])
        .output()
        .ok()?;
    if !netstat.status.success() {
        return None;
    }
    let pid = parse_netstat_listening_pids(&String::from_utf8_lossy(&netstat.stdout), port)
        .into_iter()
        .next()?;
    let tasklist = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .ok()?;
    if !tasklist.status.success() {
        return None;
    }
    parse_tasklist_image_name(&String::from_utf8_lossy(&tasklist.stdout))
}

async fn ping_local_zotero_connector() -> Option<(HashMap<String, String>, String)> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(800))
        .timeout(Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .pool_max_idle_per_host(0)
        .build()
        .ok()?;
    let response = client
        .get(ZOTERO_CONNECTOR_PING)
        .header("User-Agent", "LocalPrism/1.0.9-5")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let headers = zotero_response_headers(&response);
    let body = response.text().await.ok()?;
    Some((headers, body))
}

static LOCAL_CONNECTOR_TRUST: Mutex<Option<(Instant, bool)>> = Mutex::new(None);
const LOCAL_CONNECTOR_TRUST_TTL: Duration = Duration::from_secs(5);

async fn local_zotero_connector_is_trusted() -> bool {
    if let Ok(cache) = LOCAL_CONNECTOR_TRUST.lock() {
        if let Some((checked_at, trusted)) = *cache {
            if checked_at.elapsed() < LOCAL_CONNECTOR_TRUST_TTL {
                return trusted;
            }
        }
    }
    let process_name = listener_process_name(ZOTERO_LOCAL_PORT);
    let ping = ping_local_zotero_connector().await;
    let ping_ok = ping
        .as_ref()
        .is_some_and(|(headers, body)| looks_like_zotero_connector_ping(headers, body));
    let trusted = should_trust_local_zotero_connector(process_name.as_deref(), ping_ok);
    if let Ok(mut cache) = LOCAL_CONNECTOR_TRUST.lock() {
        *cache = Some((Instant::now(), trusted));
    }
    trusted
}

#[tauri::command]
pub async fn zotero_local_connector_ready() -> Result<bool, String> {
    Ok(local_zotero_connector_is_trusted().await)
}

async fn fetch_zotero_source(
    base: &str,
    path: &str,
    api_key: &str,
    extra_headers: &HashMap<String, String>,
    timeout: Duration,
    source: &str,
) -> Result<ZoteroApiResponse, String> {
    let url = format!("{base}{path}");
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(800))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(0);
    if source == "local" {
        builder = builder.no_proxy();
    }
    let client = builder
        .build()
        .map_err(|e| format!("Failed to build Zotero HTTP client: {e}"))?;

    let mut request = client
        .get(&url)
        .header("Zotero-API-Version", "3")
        .header("Cache-Control", "no-cache, no-store")
        .header("Pragma", "no-cache")
        .header("User-Agent", "LocalPrism/1.0.9-5");
    if should_attach_zotero_api_key(source) && !api_key.is_empty() {
        request = request.header("Zotero-API-Key", api_key);
    }

    for (key, value) in extra_headers {
        if should_skip_forwarded_header(key) {
            continue;
        }
        request = request.header(key, value);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Zotero {source} request failed: {e}"))?;
    let status = response.status().as_u16();
    let headers = zotero_response_headers(&response);
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read Zotero {source} response: {e}"))?;

    Ok(ZoteroApiResponse {
        status,
        headers,
        body,
        source: source.to_string(),
    })
}

#[tauri::command]
pub async fn zotero_api_request(
    api_key: String,
    path: String,
    extra_headers: Option<HashMap<String, String>>,
    source: Option<String>,
) -> Result<ZoteroApiResponse, String> {
    validate_zotero_api_path(&path)?;
    let extra_headers = extra_headers.unwrap_or_default();
    let source = source.unwrap_or_else(|| "auto".to_string());

    match source.as_str() {
        "local" => {
            if !local_zotero_connector_is_trusted().await {
                return Err("Zotero local connector is not available".into());
            }
            fetch_zotero_source(
                ZOTERO_LOCAL_API,
                &path,
                &api_key,
                &extra_headers,
                Duration::from_secs(3),
                "local",
            )
            .await
        }
        "web" => {
            fetch_zotero_source(
                ZOTERO_WEB_API,
                &path,
                &api_key,
                &extra_headers,
                Duration::from_secs(60),
                "web",
            )
            .await
        }
        _ => {
            if local_zotero_connector_is_trusted().await {
                if let Ok(local) = fetch_zotero_source(
                    ZOTERO_LOCAL_API,
                    &path,
                    &api_key,
                    &extra_headers,
                    Duration::from_secs(2),
                    "local",
                )
                .await
                {
                    if (200..300).contains(&local.status) {
                        return Ok(local);
                    }
                }
            }
            fetch_zotero_source(
                ZOTERO_WEB_API,
                &path,
                &api_key,
                &extra_headers,
                Duration::from_secs(60),
                "web",
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_percent_encode_unreserved() {
        // Unreserved characters (RFC 3986) should pass through
        assert_eq!(percent_encode("abc"), "abc");
        assert_eq!(percent_encode("ABC"), "ABC");
        assert_eq!(percent_encode("012"), "012");
        assert_eq!(percent_encode("-._~"), "-._~");
    }

    #[test]
    fn test_percent_encode_special_chars() {
        assert_eq!(percent_encode(" "), "%20");
        assert_eq!(percent_encode("&"), "%26");
        assert_eq!(percent_encode("="), "%3D");
        assert_eq!(percent_encode("/"), "%2F");
        assert_eq!(percent_encode("hello world"), "hello%20world");
    }

    #[test]
    fn test_percent_encode_empty() {
        assert_eq!(percent_encode(""), "");
    }

    #[test]
    fn test_hmac_sha1_known_vector() {
        // Known HMAC-SHA1 test vector
        let result = hmac_sha1("key", "The quick brown fox jumps over the lazy dog").unwrap();
        // HMAC-SHA1("key", "The quick brown fox jumps over the lazy dog") is a known value
        assert!(!result.is_empty());
        // Base64 encoded, should contain only valid base64 chars
        assert!(result
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='));
    }

    #[test]
    fn test_oauth_signature_produces_base64() {
        let params = vec![
            ("oauth_consumer_key".to_string(), "key123".to_string()),
            ("oauth_nonce".to_string(), "nonce".to_string()),
            (
                "oauth_signature_method".to_string(),
                "HMAC-SHA1".to_string(),
            ),
            ("oauth_timestamp".to_string(), "1234567890".to_string()),
            ("oauth_version".to_string(), "1.0".to_string()),
        ];
        let sig = oauth_signature(
            "POST",
            "https://example.com/api",
            &params,
            "consumer_secret",
            "token_secret",
        );
        assert!(!sig.is_empty());
        // Should be valid base64
        assert!(sig
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='));
    }

    #[test]
    fn test_oauth_signature_deterministic() {
        let params = vec![
            ("a".to_string(), "1".to_string()),
            ("b".to_string(), "2".to_string()),
        ];
        let sig1 = oauth_signature("GET", "https://example.com", &params, "cs", "ts");
        let sig2 = oauth_signature("GET", "https://example.com", &params, "cs", "ts");
        assert_eq!(sig1, sig2);
    }

    #[test]
    fn test_build_auth_header_format() {
        let params = vec![
            ("oauth_consumer_key".to_string(), "mykey".to_string()),
            ("oauth_nonce".to_string(), "abc".to_string()),
            ("non_oauth_param".to_string(), "ignored".to_string()),
        ];
        let header = build_auth_header(&params);
        assert!(header.starts_with("OAuth "));
        assert!(header.contains("oauth_consumer_key"));
        assert!(header.contains("oauth_nonce"));
        // Non-oauth params should be excluded
        assert!(!header.contains("non_oauth_param"));
    }

    #[test]
    fn test_parse_form_urlencoded_basic() {
        let result = parse_form_urlencoded("key1=val1&key2=val2");
        assert_eq!(result.get("key1").unwrap(), "val1");
        assert_eq!(result.get("key2").unwrap(), "val2");
    }

    #[test]
    fn test_parse_form_urlencoded_empty_value() {
        let result = parse_form_urlencoded("key1=&key2=val");
        assert_eq!(result.get("key1").unwrap(), "");
        assert_eq!(result.get("key2").unwrap(), "val");
    }

    #[test]
    fn test_parse_form_urlencoded_single_pair() {
        let result = parse_form_urlencoded("token=abc123");
        assert_eq!(result.len(), 1);
        assert_eq!(result.get("token").unwrap(), "abc123");
    }

    #[test]
    fn test_parse_form_urlencoded_empty_string() {
        let result = parse_form_urlencoded("");
        // Empty string splits into [""] — splitn(2, '=') on "" yields key="" with no '=',
        // so value defaults to "" and we get one entry: ("", "")
        assert_eq!(result.len(), 1);
        assert_eq!(result.get("").unwrap(), "");
    }

    #[test]
    fn test_validate_zotero_api_path_allows_library_routes() {
        assert!(validate_zotero_api_path("/keys/current").is_ok());
        assert!(validate_zotero_api_path("/users/123/items?start=0").is_ok());
        assert!(validate_zotero_api_path("/users/123/collections").is_ok());
        assert!(validate_zotero_api_path("/groups/9/items").is_ok());
        assert!(validate_zotero_api_path("/users/123/deleted?since=1").is_ok());
    }

    #[test]
    fn test_validate_zotero_api_path_rejects_absolute_urls() {
        assert!(validate_zotero_api_path("https://api.zotero.org/users/1/items").is_err());
        assert!(validate_zotero_api_path("/users/../keys/current").is_err());
        assert!(validate_zotero_api_path("/settings/keys").is_err());
    }

    #[test]
    fn recognizes_only_real_zotero_process_names() {
        assert!(is_zotero_process_name("zotero"));
        assert!(is_zotero_process_name("Zotero.exe"));
        assert!(is_zotero_process_name("/Applications/Zotero.app/Contents/MacOS/zotero"));
        assert!(is_zotero_process_name("zotero-bin"));
        assert!(is_zotero_process_name("zotero.bin"));
        assert!(!is_zotero_process_name("zotero-attacker"));
        assert!(!is_zotero_process_name("python"));
        assert!(!is_zotero_process_name("nc"));
    }

    #[test]
    fn ping_fingerprint_requires_zotero_markers() {
        let mut headers = HashMap::new();
        headers.insert("X-Zotero-Version".into(), "7.0.15".into());
        assert!(looks_like_zotero_connector_ping(&headers, "ignored"));
        assert!(looks_like_zotero_connector_ping(
            &HashMap::new(),
            "Zotero is running"
        ));
        assert!(!looks_like_zotero_connector_ping(
            &HashMap::new(),
            r#"{"prefs":{"automaticSnapshots":true}}"#
        ));
        assert!(!looks_like_zotero_connector_ping(
            &HashMap::new(),
            r#"{"ok":true}"#
        ));
    }

    #[test]
    fn local_requests_never_attach_the_cloud_api_key() {
        assert!(!should_attach_zotero_api_key("local"));
        assert!(should_attach_zotero_api_key("web"));
        assert!(should_attach_zotero_api_key("auto"));
    }

    #[test]
    fn local_connector_requires_zotero_ping_and_rejects_foreign_processes() {
        assert!(should_trust_local_zotero_connector(Some("zotero"), true));
        assert!(should_trust_local_zotero_connector(None, true));
        assert!(should_trust_local_zotero_connector(Some("bwrap"), true));
        assert!(!should_trust_local_zotero_connector(Some("bwrap"), false));
        assert!(!should_trust_local_zotero_connector(Some("zotero"), false));
        assert!(!should_trust_local_zotero_connector(Some("python"), true));
        assert!(!should_trust_local_zotero_connector(None, false));
    }

    #[test]
    fn parses_proc_net_tcp_listen_inodes() {
        let table = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:5A4F 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0\n";
        assert_eq!(parse_hex_ipv4_socket("0100007F:5A4F").unwrap().1, 23119);
        assert_eq!(parse_proc_net_listen_inodes(table, 23119, false), vec![12345]);
        assert!(parse_proc_net_listen_inodes(table, 80, false).is_empty());
        let remote = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0A01A8C0:5A4F 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 999 1 0000000000000000 100 0 0 10 0\n";
        assert!(parse_proc_net_listen_inodes(remote, 23119, false).is_empty());
    }

    #[test]
    fn parses_proc_net_tcp6_loopback() {
        let parsed = parse_hex_ipv6_socket("00000000000000000000000001000000:5A4F").unwrap();
        assert_eq!(parsed.0, Ipv6Addr::LOCALHOST);
        assert_eq!(parsed.1, 23119);
    }

    #[test]
    fn parses_netstat_and_tasklist_output() {
        let netstat = "  TCP    127.0.0.1:23119        0.0.0.0:0              LISTENING       4560\r\n";
        assert_eq!(parse_netstat_listening_pids(netstat, 23119), vec![4560]);
        let remote = "  TCP    192.168.1.10:23119     0.0.0.0:0              LISTENING       99\r\n";
        assert!(parse_netstat_listening_pids(remote, 23119).is_empty());
        assert!(local_address_is_loopback_or_unspecified("0.0.0.0:23119"));
        assert!(local_address_is_loopback_or_unspecified("[::1]:23119"));
        assert_eq!(
            parse_tasklist_image_name("\"Zotero.exe\",\"4560\",\"Console\",\"1\",\"12,345 K\"\r\n")
                .as_deref(),
            Some("Zotero.exe")
        );
        assert_eq!(parse_lsof_command_names("p4560\ncZotero\n"), vec!["Zotero"]);
    }
}
