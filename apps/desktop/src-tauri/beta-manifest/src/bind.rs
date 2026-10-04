//! Bind updater identity (version, channel, tag, URL, digest) to artifact bytes.
//!
//! Tauri minisign covers file bytes only. A signed `latest.json` attestation
//! stops a rewritten version or channel from riding on an unrelated URL.

use std::collections::BTreeMap;

use serde_json::Value;
use sha2::{Digest, Sha256};

const ATTESTATION_VERSION: &str = "localprism-updater-manifest-v1";
const RELEASE_HOST: &str = "https://github.com/boshuaiYu/LocalPrism/releases/download/";
/// Published unsigned `latest.json` tops out at 1.0.8, including
/// `1.0.8betaN` and `1.0.8-N`. Newer cores must attest identity.
const UNSIGNED_MANIFEST_CEILING: (u64, u64, u64) = (1, 0, 8);

const ALLOWED_FILES: &[&str] = &[
    "LocalPrism-Windows-setup.exe",
    "LocalPrism-macOS.app.tar.gz",
    "LocalPrism-macOS-Intel.app.tar.gz",
    "LocalPrism-Linux.AppImage",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundPlatform {
    pub url: String,
    pub digest: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundManifest {
    pub version: String,
    pub channel: String,
    pub tag: String,
    pub platforms: BTreeMap<String, BoundPlatform>,
}

pub fn channel_for_version(version: &str) -> &'static str {
    if crate::is_compact_beta_version(version) || version.trim().contains('-') {
        "beta"
    } else {
        "stable"
    }
}

pub fn tag_for_version(version: &str) -> String {
    let trimmed = version.trim();
    if trimmed.starts_with('v') || trimmed.starts_with('V') {
        trimmed.to_string()
    } else {
        format!("v{trimmed}")
    }
}

pub fn canonical_attestation(
    version: &str,
    channel: &str,
    tag: &str,
    platforms: &BTreeMap<String, BoundPlatform>,
) -> String {
    let mut out = String::new();
    out.push_str(ATTESTATION_VERSION);
    out.push('\n');
    out.push_str("channel=");
    out.push_str(channel);
    out.push('\n');
    out.push_str("tag=");
    out.push_str(tag);
    out.push('\n');
    out.push_str("version=");
    out.push_str(version);
    out.push('\n');
    for (name, platform) in platforms {
        out.push_str(name);
        out.push_str(" digest=");
        out.push_str(&platform.digest);
        out.push_str(" url=");
        out.push_str(&platform.url);
        out.push('\n');
    }
    out
}

pub fn sha256_digest(bytes: &[u8]) -> String {
    let hashed = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for byte in hashed {
        hex.push_str(&format!("{byte:02x}"));
    }
    format!("sha256:{hex}")
}

pub fn decode_updater_pubkey(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if let Some(line) = public_key_line(trimmed) {
        return Ok(line);
    }
    let Ok(raw) = base64_decode(trimmed) else {
        return Err("Updater public key is not a minisign key.".to_string());
    };
    let text = String::from_utf8(raw)
        .map_err(|_| "Updater public key is not a minisign key.".to_string())?;
    public_key_line(&text).ok_or_else(|| "Updater public key is not a minisign key.".to_string())
}

pub fn bind_updater_manifest(raw: &str, pubkey: &str) -> Result<BoundManifest, String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|err| format!("Updater manifest is not JSON: {err}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "Updater manifest is not an object.".to_string())?;
    let version = required_string(object.get("version"), "version")?;
    let expected_channel = channel_for_version(&version).to_string();
    let channel =
        optional_string(object.get("channel")).unwrap_or_else(|| expected_channel.clone());
    let tag = optional_string(object.get("tag")).unwrap_or_else(|| tag_for_version(&version));
    let attestation = optional_string(object.get("manifest_signature"));
    let platforms_value = object
        .get("platforms")
        .and_then(Value::as_object)
        .ok_or_else(|| "Updater manifest has no platforms.".to_string())?;
    if platforms_value.is_empty() {
        return Err("Updater manifest has no platforms.".to_string());
    }

    if channel != expected_channel {
        return Err(format!(
            "Updater channel {channel} does not match version {version}."
        ));
    }
    if !tag_matches_version(&tag, &version) {
        return Err(format!(
            "Updater tag {tag} does not match version {version}."
        ));
    }

    let mut platforms = BTreeMap::new();
    for (name, entry) in platforms_value {
        if name.is_empty()
            || !name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        {
            return Err("Updater platform name is invalid.".to_string());
        }
        let url = required_string(entry.get("url"), "url")?;
        let digest = match optional_string(entry.get("digest")) {
            Some(value) => normalize_digest(&value)?,
            None => String::new(),
        };
        let artifact_signature = entry
            .get("signature")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if artifact_signature.is_empty() {
            return Err(format!("Updater platform {name} is missing a signature."));
        }
        validate_release_url(&url, &tag)?;
        platforms.insert(
            name.clone(),
            BoundPlatform {
                url,
                digest,
                signature: artifact_signature,
            },
        );
    }

    let requires_signed = version_requires_signed_identity(&version);
    if requires_signed && attestation.is_none() {
        return Err(
            "Updater manifests newer than 1.0.8 must include a manifest_signature.".to_string(),
        );
    }
    if requires_signed
        && platforms
            .values()
            .any(|platform| platform.digest.is_empty())
    {
        return Err(
            "Updater manifests newer than 1.0.8 must include an artifact digest on every platform."
                .to_string(),
        );
    }
    if let Some(signature) = attestation {
        if platforms
            .values()
            .any(|platform| platform.digest.is_empty())
        {
            return Err("Signed updater manifests must include artifact digests.".to_string());
        }
        let canonical = canonical_attestation(&version, &channel, &tag, &platforms);
        verify_minisign(pubkey, canonical.as_bytes(), &signature)?;
    }
    Ok(BoundManifest {
        version,
        channel,
        tag,
        platforms,
    })
}

impl BoundManifest {
    pub fn verify_artifact_bytes(&self, bytes: &[u8]) -> Result<(), String> {
        let expected: Vec<&String> = self
            .platforms
            .values()
            .map(|platform| &platform.digest)
            .filter(|digest| !digest.is_empty())
            .collect();
        if expected.is_empty() {
            if version_requires_signed_identity(&self.version) {
                return Err("Downloaded update is missing a signed digest.".to_string());
            }
            // Published 1.0.8 / 1.0.8betaN only signed the artifact bytes.
            return Ok(());
        }
        let digest = sha256_digest(bytes);
        if expected.iter().any(|wanted| *wanted == &digest) {
            return Ok(());
        }
        Err("Downloaded update does not match the signed digest.".to_string())
    }
}

pub fn version_requires_signed_identity(version: &str) -> bool {
    match version_core(version) {
        Some(core) => core > UNSIGNED_MANIFEST_CEILING,
        None => true,
    }
}

fn version_core(version: &str) -> Option<(u64, u64, u64)> {
    let trimmed = version.trim().trim_start_matches(['v', 'V']);
    let before_beta = match trimmed.to_ascii_lowercase().find("beta") {
        Some(index) => &trimmed[..index],
        None => trimmed,
    };
    let core = before_beta
        .split(['-', '+'])
        .next()
        .filter(|part| !part.is_empty())?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

fn required_string(value: Option<&Value>, field: &str) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| format!("Updater manifest is missing {field}."))
}

fn normalize_digest(digest: &str) -> Result<String, String> {
    let lower = digest.trim().to_ascii_lowercase();
    let hex = lower
        .strip_prefix("sha256:")
        .ok_or_else(|| "Updater digest must be sha256:<hex>.".to_string())?;
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Updater digest must be sha256:<hex>.".to_string());
    }
    Ok(format!("sha256:{hex}"))
}

fn tag_matches_version(tag: &str, version: &str) -> bool {
    let tag = tag.trim();
    let version = version.trim();
    tag == version || tag == format!("v{version}") || tag == format!("V{version}")
}

fn validate_release_url(url: &str, tag: &str) -> Result<(), String> {
    if url.contains('?') || url.contains('#') || url.contains('\\') || url.contains("..") {
        return Err("Updater artifact URL is invalid.".to_string());
    }
    let rest = url
        .strip_prefix(RELEASE_HOST)
        .ok_or_else(|| "Updater artifact URL is not a LocalPrism release asset.".to_string())?;
    let (url_tag, file) = rest
        .split_once('/')
        .ok_or_else(|| "Updater artifact URL is not a LocalPrism release asset.".to_string())?;
    if url_tag != tag {
        return Err(format!(
            "Updater artifact URL tag {url_tag} does not match manifest tag {tag}."
        ));
    }
    if !ALLOWED_FILES.contains(&file) {
        return Err("Updater artifact filename is not an allowed release asset.".to_string());
    }
    Ok(())
}

fn public_key_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| line.starts_with("RW") && line.len() > 40)
        .map(ToString::to_string)
}

fn base64_decode(input: &str) -> Result<Vec<u8>, ()> {
    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, input).map_err(|_| ())
}

fn decode_minisign_signature(signature: &str) -> Result<minisign_verify::Signature, String> {
    let trimmed = signature.trim();
    if let Ok(decoded) = minisign_verify::Signature::decode(trimmed) {
        return Ok(decoded);
    }
    // `tauri signer sign` writes the same base64 envelope used for artifact
    // signatures in latest.json, not raw minisign text.
    if let Ok(raw) = base64_decode(trimmed) {
        if let Ok(text) = String::from_utf8(raw) {
            if let Ok(decoded) = minisign_verify::Signature::decode(text.trim()) {
                return Ok(decoded);
            }
        }
    }
    Err("Updater manifest signature is invalid: Invalid encoding in minisign data".to_string())
}

fn verify_minisign(pubkey: &str, data: &[u8], signature: &str) -> Result<(), String> {
    let key_line = decode_updater_pubkey(pubkey)?;
    let public_key = minisign_verify::PublicKey::from_base64(&key_line)
        .map_err(|err| format!("Updater public key is invalid: {err}"))?;
    let decoded = decode_minisign_signature(signature)?;
    public_key
        .verify(data, &decoded, true)
        .map_err(|_| "Updater manifest signature does not match the signed identity.".to_string())
}
