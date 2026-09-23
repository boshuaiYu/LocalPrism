//! Compact tags such as `1.0.8beta3` are not semver.
//! Tauri's updater rejects them before it compares versions or checks
//! the minisign signature. This crate rewrites only the `version` field
//! to a gate semver and serves that JSON once on localhost so the
//! existing updater can download the original signed asset.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::ServerConfig;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_rustls::TlsAcceptor;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewrittenManifest {
    pub json: String,
    pub display_version: String,
    pub gate_version: String,
}

pub struct LocalManifest {
    pub url: String,
    pub root_pem: String,
    shutdown: Option<oneshot::Sender<()>>,
}

impl Drop for LocalManifest {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

pub fn is_compact_beta_version(version: &str) -> bool {
    compact_beta(version).is_some()
}

/// True when the tag asset uses a compact beta version (`v1.0.8beta3`).
/// Hyphenated semver tags stay on the normal updater endpoint.
pub fn manifest_needs_version_gate(url: &str) -> bool {
    let Some(tag) = tag_from_manifest_url(url) else {
        return false;
    };
    is_compact_beta_version(tag)
}

/// A semver that is newer than `current` for any `major.minor.patch`
/// the app can already be built with. `1.0.8` and `1.0.8-2` both lose
/// to `1.0.9-beta.0`. The UI still shows the original tag.
pub fn updater_gate_version(current: &str) -> Result<String, String> {
    let (major, minor, patch) = semver_core(current)?;
    let next_patch = patch
        .checked_add(1)
        .ok_or_else(|| "App version is too large to gate a beta manifest.".to_string())?;
    Ok(format!("{major}.{minor}.{next_patch}-beta.0"))
}

/// True when `candidate` should replace `current`.
/// `1.0.8beta2` is not newer than the WiX version `1.0.8-2`.
/// `1.0.8beta3` is. A compact tag is newer than the plain release
/// of the same core (`1.0.8beta2` > `1.0.8`).
pub fn compact_release_is_newer(candidate: &str, current: &str) -> Result<bool, String> {
    let next =
        parse_release(candidate).ok_or_else(|| format!("Cannot read beta version {candidate}."))?;
    if next.compact.is_none() {
        return Err(format!(
            "Beta manifest version is not a compact prerelease such as 1.0.8beta3."
        ));
    }
    let previous =
        parse_release(current).ok_or_else(|| format!("Cannot read the app version {current}."))?;
    Ok(compare_release(&next, &previous) > 0)
}

pub fn rewrite_compact_manifest(
    raw: &str,
    current_version: &str,
) -> Result<RewrittenManifest, String> {
    let mut value: Value =
        serde_json::from_str(raw).map_err(|err| format!("Beta manifest is not JSON: {err}"))?;
    let display_version = value
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| "Beta manifest has no version.".to_string())?
        .trim()
        .to_string();
    if !is_compact_beta_version(&display_version) {
        return Err(
            "Beta manifest version is not a compact prerelease such as 1.0.8beta3.".to_string(),
        );
    }
    let gate_version = updater_gate_version(current_version)?;
    if let Some(object) = value.as_object_mut() {
        object.insert("version".to_string(), Value::String(gate_version.clone()));
    }
    let json = serde_json::to_string(&value)
        .map_err(|err| format!("Could not rewrite the beta manifest: {err}"))?;
    Ok(RewrittenManifest {
        json,
        display_version,
        gate_version,
    })
}

pub async fn serve_local_manifest(json: String) -> Result<LocalManifest, String> {
    let identity = local_identity()?;
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .await
        .map_err(|err| format!("Could not listen for the beta manifest: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("Could not read the beta manifest port: {err}"))?
        .port();
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let acceptor = TlsAcceptor::from(Arc::new(identity.config));
    let body = Arc::new(json);
    tokio::spawn(async move {
        serve_until_shutdown(listener, acceptor, body, shutdown_rx).await;
    });
    Ok(LocalManifest {
        url: format!("https://127.0.0.1:{port}/latest.json"),
        root_pem: identity.root_pem,
        shutdown: Some(shutdown_tx),
    })
}

fn compact_beta(version: &str) -> Option<()> {
    compact_beta_shape(version.trim()).then_some(())
}

/// `1.0.8beta3` or `v1.0.8BETA3`. Hyphenated `1.0.8-beta.2` does not match.
fn compact_beta_shape(version: &str) -> bool {
    let rest = version.strip_prefix(['v', 'V']).unwrap_or(version);
    let Some((core, beta_digits)) = split_beta_suffix(rest) else {
        return false;
    };
    if beta_digits.is_empty() || !beta_digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let mut parts = core.split('.');
    let Some(major) = parts.next() else {
        return false;
    };
    let Some(minor) = parts.next() else {
        return false;
    };
    let Some(patch) = parts.next() else {
        return false;
    };
    parts.next().is_none()
        && !major.is_empty()
        && !minor.is_empty()
        && !patch.is_empty()
        && major.bytes().all(|byte| byte.is_ascii_digit())
        && minor.bytes().all(|byte| byte.is_ascii_digit())
        && patch.bytes().all(|byte| byte.is_ascii_digit())
}

fn split_beta_suffix(version: &str) -> Option<(&str, &str)> {
    let index = version.to_ascii_lowercase().rfind("beta")?;
    let (core, suffix) = version.split_at(index);
    let digits = suffix.get(4..)?;
    if core.is_empty() {
        return None;
    }
    Some((core, digits))
}

struct ReleaseVersion {
    major: u64,
    minor: u64,
    patch: u64,
    compact: Option<u64>,
    numeric_pre: Option<u64>,
    other_pre: bool,
}

fn parse_release(input: &str) -> Option<ReleaseVersion> {
    let trimmed = input.trim();
    if let Some((core, digits)) = compact_parts(trimmed) {
        let (major, minor, patch) = split_core(core)?;
        let compact = digits.parse::<u64>().ok()?;
        return Some(ReleaseVersion {
            major,
            minor,
            patch,
            compact: Some(compact),
            numeric_pre: None,
            other_pre: false,
        });
    }
    let trimmed = trimmed.trim_start_matches(['v', 'V']);
    let (core, pre) = trimmed.split_once('-').unwrap_or((trimmed, ""));
    let (major, minor, patch) = split_core(core.split('+').next().unwrap_or(core))?;
    if pre.is_empty() || pre.starts_with('+') {
        return Some(ReleaseVersion {
            major,
            minor,
            patch,
            compact: None,
            numeric_pre: None,
            other_pre: false,
        });
    }
    let pre = pre.split('+').next().unwrap_or(pre);
    let mut ids = pre.split('.');
    let first = ids.next().unwrap_or("");
    let single_numeric =
        ids.next().is_none() && !first.is_empty() && first.bytes().all(|b| b.is_ascii_digit());
    Some(ReleaseVersion {
        major,
        minor,
        patch,
        compact: None,
        numeric_pre: if single_numeric {
            first.parse::<u64>().ok()
        } else {
            None
        },
        other_pre: !single_numeric,
    })
}

fn compact_parts(version: &str) -> Option<(&str, &str)> {
    if !compact_beta_shape(version) {
        return None;
    }
    let rest = version.trim().trim_start_matches(['v', 'V']);
    split_beta_suffix(rest)
}

fn split_core(core: &str) -> Option<(u64, u64, u64)> {
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn compare_release(left: &ReleaseVersion, right: &ReleaseVersion) -> i32 {
    if left.major != right.major {
        return (left.major > right.major) as i32 - (left.major < right.major) as i32;
    }
    if left.minor != right.minor {
        return (left.minor > right.minor) as i32 - (left.minor < right.minor) as i32;
    }
    if left.patch != right.patch {
        return (left.patch > right.patch) as i32 - (left.patch < right.patch) as i32;
    }
    if left.compact.is_some() || right.compact.is_some() {
        if let (Some(left_n), Some(right_n)) = (left.compact, right.compact) {
            return (left_n > right_n) as i32 - (left_n < right_n) as i32;
        }
        let left_build = left
            .compact
            .or(left.numeric_pre.filter(|_| !left.other_pre));
        let right_build = right
            .compact
            .or(right.numeric_pre.filter(|_| !right.other_pre));
        if left.compact.is_some() != right.compact.is_some() {
            if let (Some(left_n), Some(right_n)) = (left_build, right_build) {
                return (left_n > right_n) as i32 - (left_n < right_n) as i32;
            }
        }
        return if left.compact.is_some() { 1 } else { -1 };
    }
    0
}

fn semver_core(current: &str) -> Result<(u64, u64, u64), String> {
    let trimmed = current.trim().trim_start_matches(['v', 'V']);
    let core = trimmed
        .split(['-', '+'])
        .next()
        .filter(|part| !part.is_empty())
        .ok_or_else(|| format!("Cannot read the app version {current}."))?;
    let mut parts = core.split('.');
    let major = parse_component(parts.next(), current)?;
    let minor = parse_component(parts.next(), current)?;
    let patch = parse_component(parts.next(), current)?;
    if parts.next().is_some() {
        return Err(format!("Cannot read the app version {current}."));
    }
    Ok((major, minor, patch))
}

fn parse_component(part: Option<&str>, current: &str) -> Result<u64, String> {
    part.ok_or_else(|| format!("Cannot read the app version {current}."))?
        .parse::<u64>()
        .map_err(|_| format!("Cannot read the app version {current}."))
}

fn tag_from_manifest_url(url: &str) -> Option<&str> {
    let rest = url
        .trim()
        .strip_prefix("https://github.com/boshuaiYu/LocalPrism/releases/download/")?;
    let (tag, file) = rest.split_once('/')?;
    if file != "latest.json" || tag.is_empty() || tag == "latest" {
        return None;
    }
    Some(tag)
}

struct LocalIdentity {
    config: ServerConfig,
    root_pem: String,
}

const LOOPBACK_CERT_DER: &[u8] = include_bytes!("../certs/localhost.der");
const LOOPBACK_KEY_DER: &[u8] = include_bytes!("../certs/localhost.pkcs8.der");
const LOOPBACK_CA_PEM: &str = include_str!("../certs/ca.crt");

/// The leaf key only serves `127.0.0.1`. Callers that can add `ca.pem`
/// as a root keep normal hostname checks. The updater plugin cannot share
/// that certificate type, so it accepts this loopback certificate only.
fn local_identity() -> Result<LocalIdentity, String> {
    let cert_der = CertificateDer::from(LOOPBACK_CERT_DER.to_vec());
    let key_der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(LOOPBACK_KEY_DER.to_vec()));
    let config = server_config(cert_der, key_der)?;
    Ok(LocalIdentity {
        config,
        root_pem: LOOPBACK_CA_PEM.to_string(),
    })
}

fn server_config(
    cert: CertificateDer<'static>,
    key: PrivateKeyDer<'static>,
) -> Result<ServerConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|err| format!("Could not configure the beta manifest server: {err}"))?
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)
        .map_err(|err| format!("Could not configure the beta manifest server: {err}"))
}

async fn serve_until_shutdown(
    listener: TcpListener,
    acceptor: TlsAcceptor,
    body: Arc<String>,
    mut shutdown: oneshot::Receiver<()>,
) {
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => {
                let Ok((tcp, _)) = accepted else {
                    break;
                };
                let acceptor = acceptor.clone();
                let body = Arc::clone(&body);
                tokio::spawn(async move {
                    if let Ok(stream) = acceptor.accept(tcp).await {
                        let _ = write_json(stream, &body).await;
                    }
                });
            }
        }
    }
}

async fn write_json(
    mut stream: tokio_rustls::server::TlsStream<TcpStream>,
    body: &str,
) -> std::io::Result<()> {
    let mut buf = [0_u8; 1024];
    let mut received = Vec::new();
    loop {
        let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf)).await;
        let count = match read {
            Ok(Ok(0)) | Err(_) => return Ok(()),
            Ok(Ok(count)) => count,
            Ok(Err(err)) => return Err(err),
        };
        received.extend_from_slice(&buf[..count]);
        if received.windows(4).any(|window| window == b"\r\n\r\n") || received.len() > 8192 {
            break;
        }
    }
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::{
        compact_release_is_newer, is_compact_beta_version, manifest_needs_version_gate,
        rewrite_compact_manifest, serve_local_manifest, updater_gate_version,
    };

    #[test]
    fn compact_tags_need_a_gate_and_hyphen_tags_do_not() {
        assert!(is_compact_beta_version("1.0.8beta3"));
        assert!(is_compact_beta_version("v1.0.8BETA2"));
        assert!(!is_compact_beta_version("1.0.8"));
        assert!(!is_compact_beta_version("1.0.8-2"));
        assert!(!is_compact_beta_version("1.0.8-beta.2"));
        assert!(manifest_needs_version_gate(
            "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.8beta3/latest.json"
        ));
        assert!(!manifest_needs_version_gate(
            "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.8-2/latest.json"
        ));
        assert!(!manifest_needs_version_gate(
            "https://github.com/boshuaiYu/LocalPrism/releases/latest/download/latest.json"
        ));
    }

    #[test]
    fn gate_is_a_newer_semver_than_the_running_build() {
        assert_eq!(updater_gate_version("1.0.8").as_deref(), Ok("1.0.9-beta.0"));
        assert_eq!(
            updater_gate_version("1.0.8-2").as_deref(),
            Ok("1.0.9-beta.0")
        );
        assert!(updater_gate_version("not-a-version").is_err());
    }

    #[test]
    fn the_wix_build_number_is_the_same_release_as_that_compact_tag() {
        assert_eq!(
            compact_release_is_newer("1.0.8beta2", "1.0.8-2").ok(),
            Some(false)
        );
        assert_eq!(
            compact_release_is_newer("1.0.8beta1", "1.0.8-2").ok(),
            Some(false)
        );
        assert_eq!(
            compact_release_is_newer("1.0.8beta3", "1.0.8-2").ok(),
            Some(true)
        );
        assert_eq!(
            compact_release_is_newer("1.0.8beta2", "1.0.8").ok(),
            Some(true)
        );
        assert_eq!(
            compact_release_is_newer("1.0.8beta3", "1.0.9").ok(),
            Some(false)
        );
    }

    #[test]
    fn rewrite_changes_only_the_version_field() {
        let raw = r#"{"version":"1.0.8beta3","notes":"beta","platforms":{"darwin-aarch64":{"url":"https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.8beta3/app.tar.gz","signature":"sig"}}}"#;
        let rewritten = rewrite_compact_manifest(raw, "1.0.8-2").expect("rewrite");
        assert_eq!(rewritten.display_version, "1.0.8beta3");
        assert_eq!(rewritten.gate_version, "1.0.9-beta.0");
        assert!(rewritten.json.contains("\"version\":\"1.0.9-beta.0\""));
        assert!(rewritten.json.contains("v1.0.8beta3/app.tar.gz"));
        assert!(rewritten.json.contains("\"signature\":\"sig\""));
        assert!(!rewritten.json.contains("1.0.8beta3\",\"notes"));
    }

    #[tokio::test]
    async fn localhost_manifest_roundtrip_keeps_normal_certificate_checks() {
        let served = serve_local_manifest(r#"{"version":"1.0.9-beta.0"}"#.to_string())
            .await
            .expect("server");
        let cert = reqwest::Certificate::from_pem(served.root_pem.as_bytes()).expect("pem");
        let client = reqwest::Client::builder()
            .add_root_certificate(cert)
            .build()
            .expect("client");
        let body = client
            .get(&served.url)
            .send()
            .await
            .expect("get")
            .text()
            .await
            .expect("body");
        assert_eq!(body, r#"{"version":"1.0.9-beta.0"}"#);
        let url = served.url.clone();
        drop(served);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(client.get(url).send().await.is_err());
    }
}
