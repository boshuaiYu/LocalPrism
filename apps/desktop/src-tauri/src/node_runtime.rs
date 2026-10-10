//! Private Node.js / npx runtime owned by LocalPrism.
//!
//! The official LTS archive is downloaded from nodejs.org, checked against
//! `SHASUMS256.txt`, and extracted under `{LOCALPRISM_HOME}/runtimes/node`.
//! `SHASUMS256.txt` is not GPG-signed. The threat model is nodejs.org's TLS:
//! the release index, the checksum file, and the archive must all come from
//! `https://nodejs.org`, and the archive digest must match that checksum file.
//! A same-host or certificate compromise could still present a matching pair.
//!
//! Nothing is written to the system PATH or to a global Node install. Child
//! processes started for agents see the managed `bin` directory first, and
//! only after `node --version` succeeds.

use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use tauri::{Emitter, WebviewWindow};

const INDEX_URL: &str = "https://nodejs.org/dist/index.json";
const MAX_INDEX_BYTES: usize = 4 * 1024 * 1024;
const MAX_SUMS_BYTES: usize = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: usize = 80 * 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 128 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: usize = 400 * 1024 * 1024;
const MAX_PATH_CHARS: usize = 1024;
const MAX_NODE_REDIRECTS: usize = 5;
const ALREADY_INSTALLING: &str = "Node.js installation is already running.";

static NODE_INSTALL_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
std::thread_local! {
    static FAIL_ROOT_RENAME: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArchiveKind {
    Zip,
    TarGz,
    TarXz,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NodeDistAsset {
    pub version: String,
    pub filename: String,
    pub url: String,
    pub shasums_url: String,
    pub kind: ArchiveKind,
}

#[derive(Debug, Clone)]
struct NodeLayout {
    home: PathBuf,
    root: PathBuf,
}

#[derive(serde::Serialize)]
pub struct NodeRuntimeStatus {
    pub available: bool,
    pub source: Option<String>,
    pub version: Option<String>,
    pub node_path: Option<String>,
    pub npx_path: Option<String>,
    pub managed_dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FoundRuntime {
    version: String,
    node_path: String,
    npx_path: String,
}

impl NodeLayout {
    fn resolve() -> Result<Self, String> {
        let home = crate::providers::paths::localprism_home()?;
        let root = home.join("runtimes").join("node");
        Ok(Self { home, root })
    }
}

fn path_sep() -> &'static str {
    if cfg!(windows) {
        ";"
    } else {
        ":"
    }
}

pub(crate) fn node_dist_asset(
    os: &str,
    arch: &str,
    version: &str,
) -> Result<NodeDistAsset, String> {
    let version = normalize_version(version)?;
    let (platform, kind) = match (os, arch) {
        ("windows", "x86_64") => ("win-x64", ArchiveKind::Zip),
        ("windows", "aarch64") => ("win-arm64", ArchiveKind::Zip),
        ("macos", "x86_64") => ("darwin-x64", ArchiveKind::TarGz),
        ("macos", "aarch64") => ("darwin-arm64", ArchiveKind::TarGz),
        ("linux", "x86_64") => ("linux-x64", ArchiveKind::TarXz),
        ("linux", "aarch64") => ("linux-arm64", ArchiveKind::TarXz),
        _ => return Err(format!("No official Node.js build for {os}/{arch}.")),
    };
    let ext = match kind {
        ArchiveKind::Zip => "zip",
        ArchiveKind::TarGz => "tar.gz",
        ArchiveKind::TarXz => "tar.xz",
    };
    let filename = format!("node-{version}-{platform}.{ext}");
    Ok(NodeDistAsset {
        url: format!("https://nodejs.org/dist/{version}/{filename}"),
        shasums_url: format!("https://nodejs.org/dist/{version}/SHASUMS256.txt"),
        version,
        filename,
        kind,
    })
}

fn normalize_version(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    let version = trimmed.strip_prefix('v').unwrap_or(trimmed);
    let parts: Vec<&str> = version.split('.').collect();
    let numeric = parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()));
    if !numeric {
        return Err(format!("Invalid Node.js version {raw}."));
    }
    Ok(format!("v{version}"))
}

pub(crate) fn select_lts_version(index_json: &str) -> Result<String, String> {
    let entries: Vec<serde_json::Value> = serde_json::from_str(index_json)
        .map_err(|err| format!("Failed to read the Node.js release index: {err}"))?;
    for entry in entries {
        if !is_lts(entry.get("lts")) {
            continue;
        }
        let Some(version) = entry.get("version").and_then(|value| value.as_str()) else {
            continue;
        };
        return normalize_version(version);
    }
    Err("Could not find a Node.js LTS release.".to_string())
}

fn is_lts(value: Option<&serde_json::Value>) -> bool {
    match value {
        Some(serde_json::Value::Bool(active)) => *active,
        Some(serde_json::Value::String(name)) => !name.trim().is_empty(),
        _ => false,
    }
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push(HEX[(byte >> 4) as usize] as char);
        hex.push(HEX[(byte & 0xf) as usize] as char);
    }
    hex
}

pub(crate) fn expected_sha256(shasums: &str, filename: &str) -> Result<String, String> {
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
    {
        return Err(format!("Refusing checksum lookup for {filename}."));
    }
    for line in shasums.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(hash) = parts.next() else {
            continue;
        };
        let Some(name) = parts.next() else {
            continue;
        };
        let name = name.trim_start_matches('*');
        if name != filename {
            continue;
        }
        let hash = hash.to_ascii_lowercase();
        if hash.len() != 64 || !hash.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Err(format!(
                "SHASUMS256.txt has an invalid digest for {filename}."
            ));
        }
        return Ok(hash);
    }
    Err(format!("SHASUMS256.txt has no entry for {filename}."))
}

pub(crate) fn verify_sha256(bytes: &[u8], expected_hex: &str) -> Result<(), String> {
    let actual = sha256_hex(bytes);
    let expected = expected_hex.trim().to_ascii_lowercase();
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "Downloaded archive SHA-256 {actual} does not match SHASUMS256.txt."
        ))
    }
}

pub(crate) fn prepend_path_entry(current: &str, dir: &str, sep: &str) -> String {
    if dir.is_empty()
        || sep.is_empty()
        || dir.contains(sep)
        || dir.contains('\0')
        || dir.contains('\n')
    {
        return current.to_string();
    }
    let mut parts: Vec<&str> = current
        .split(sep)
        .filter(|part| !part.is_empty() && *part != dir)
        .collect();
    parts.insert(0, dir);
    parts.join(sep)
}

/// Prepend the managed Node bin directory for a child process.
///
/// This only returns a new PATH string. It does not change the current
/// process environment or the system PATH.
pub(crate) fn prepend_managed_node_path(current: &str) -> String {
    match managed_bin_dir() {
        Some(dir) => prepend_path_entry(current, &dir.to_string_lossy(), path_sep()),
        None => current.to_string(),
    }
}

fn managed_bin_dir() -> Option<PathBuf> {
    let layout = NodeLayout::resolve().ok()?;
    let bin = runtime_bin_dir(&layout.root)?;
    let node = if tool_exists(&bin.join("node.exe")) {
        bin.join("node.exe")
    } else {
        bin.join("node")
    };
    // Same usability bar as check_node_runtime: a present but broken,
    // unfinished, or wrong-architecture copy must not hide a working system node.
    node_version_blocking(&node)?;
    Some(bin)
}

fn runtime_bin_dir(root: &Path) -> Option<PathBuf> {
    let unix = root.join("bin");
    if tool_exists(&unix.join("node")) && tool_exists(&unix.join("npx")) {
        return Some(unix);
    }
    if tool_exists(&root.join("node.exe")) && tool_exists(&root.join("npx.cmd")) {
        return Some(root.to_path_buf());
    }
    None
}

fn tool_exists(path: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => meta.file_type().is_symlink() || meta.is_file(),
        Err(_) => false,
    }
}

fn node_download_client() -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .user_agent("LocalPrism")
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(600))
        .https_only(true)
        .redirect(node_redirect_policy());
    crate::updater_proxy::install_on_download_client(builder, crate::updater_proxy::current())
        .build()
        .map_err(|err| format!("Failed to start download: {err}"))
}

fn node_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= MAX_NODE_REDIRECTS {
            return attempt.error("too many redirects");
        }
        match require_nodejs_org(attempt.url()) {
            Ok(()) => attempt.follow(),
            Err(error) => attempt.error(error),
        }
    })
}

pub(crate) fn official_node_download_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|err| format!("Refusing Node.js download URL {url}: {err}"))?;
    require_nodejs_org(&parsed)?;
    Ok(parsed)
}

fn require_nodejs_org(url: &reqwest::Url) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err(format!(
            "Refusing Node.js download URL {}: https is required.",
            url.as_str()
        ));
    }
    match url.host_str() {
        Some(host) if host.eq_ignore_ascii_case("nodejs.org") => Ok(()),
        _ => Err(format!(
            "Refusing Node.js download URL {}: host must be nodejs.org.",
            url.as_str()
        )),
    }
}

async fn download_limited(
    client: &reqwest::Client,
    url: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let url = official_node_download_url(url)?;
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|err| format!("Failed to download {url}: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("Failed to download {url} ({}).", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|len| len > max_bytes as u64)
    {
        return Err(format!("Download is larger than {max_bytes} bytes: {url}"));
    }
    let mut body = Vec::new();
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("Failed to read {url}: {err}"))?
    {
        if body.len() + chunk.len() > max_bytes {
            return Err(format!("Download is larger than {max_bytes} bytes: {url}"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn ensure_inside_home(layout: &NodeLayout, path: &Path) -> Result<(), String> {
    if runtime_path_inside_home(
        &path.to_string_lossy(),
        &layout.home.to_string_lossy(),
        cfg!(windows),
    ) {
        Ok(())
    } else {
        Err("Refusing to touch a Node.js path outside app data.".to_string())
    }
}

/// App-data containment for install, swap, and remove.
///
/// Absolute homes always contain `Component::RootDir`, and Windows homes also
/// contain `Component::Prefix`. Those are not escapes. The only lexical escape
/// rejected here is `ParentDir`. Containment is `starts_with(home)` after the
/// same verbatim-prefix and case normalization skill paths use, plus a
/// separator so `LocalPrism-extra` is not inside `LocalPrism`.
pub(crate) fn runtime_path_inside_home(path: &str, home: &str, case_insensitive: bool) -> bool {
    if path.trim().is_empty() || home.trim().is_empty() {
        return false;
    }
    let path = crate::skills::manifest::normalize_skill_path(path);
    let home = crate::skills::manifest::normalize_skill_path(home);
    if path.is_empty() || home.is_empty() || has_parent_segment(&path) || has_parent_segment(&home)
    {
        return false;
    }
    let (path_key, home_key) = if case_insensitive {
        (path.to_ascii_lowercase(), home.to_ascii_lowercase())
    } else {
        (path, home)
    };
    match path_key.strip_prefix(&home_key) {
        Some(rest) => rest.starts_with('/') && rest.len() > 1,
        None => false,
    }
}

fn has_parent_segment(path: &str) -> bool {
    path.split('/').any(|part| part == "..")
}

fn remove_tree(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() || meta.is_file() => std::fs::remove_file(path)
            .map_err(|err| format!("Failed to remove {}: {err}", path.display())),
        Ok(_) => std::fs::remove_dir_all(path)
            .map_err(|err| format!("Failed to remove {}: {err}", path.display())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Failed to inspect {}: {err}", path.display())),
    }
}

fn rename_path(from: &Path, to: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    {
        let fail_root = FAIL_ROOT_RENAME.with(|flag| flag.get());
        if fail_root && from.file_name().and_then(|name| name.to_str()) == Some("node") {
            return Err(std::io::Error::other("node runtime is in use"));
        }
    }
    std::fs::rename(from, to)
}

fn reset_directory(path: &Path) -> Result<(), String> {
    remove_tree(path)?;
    std::fs::create_dir_all(path)
        .map_err(|err| format!("Failed to create {}: {err}", path.display()))
}

fn accepted_version(stdout: &str, stderr: &str) -> Option<String> {
    let text = if stdout.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };
    if text.is_empty() || text.len() > 80 || text.chars().any(|ch| ch.is_control()) {
        return None;
    }
    Some(text.to_string())
}

fn configure_version_command(command: &mut std::process::Command) {
    command
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

async fn node_version(path: &Path) -> Option<String> {
    let mut command = tokio::process::Command::new(path);
    configure_version_command(command.as_std_mut());
    let output = tokio::time::timeout(Duration::from_secs(8), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    accepted_version(&stdout, &stderr)
}

fn node_version_blocking(path: &Path) -> Option<String> {
    let mut command = std::process::Command::new(path);
    configure_version_command(&mut command);
    let mut child = command.spawn().ok()?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > Duration::from_secs(8) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(_) => return None,
        }
    };
    if !status.success() {
        return None;
    }
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut stdout);
    }
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    accepted_version(&stdout, &stderr)
}

async fn probe_runtime(node: &Path, npx: &Path) -> Option<FoundRuntime> {
    if !tool_exists(node) || !tool_exists(npx) {
        return None;
    }
    let version = node_version(node).await?;
    Some(FoundRuntime {
        version,
        node_path: node.to_string_lossy().into_owned(),
        npx_path: npx.to_string_lossy().into_owned(),
    })
}

async fn managed_runtime(layout: &NodeLayout) -> Option<FoundRuntime> {
    let bin = runtime_bin_dir(&layout.root)?;
    let (node, npx) = if tool_exists(&bin.join("node.exe")) && tool_exists(&bin.join("npx.cmd")) {
        (bin.join("node.exe"), bin.join("npx.cmd"))
    } else {
        (bin.join("node"), bin.join("npx"))
    };
    probe_runtime(&node, &npx).await
}

async fn system_runtime() -> Option<FoundRuntime> {
    let node = which::which("node").ok()?;
    let npx = which::which("npx")
        .or_else(|_| which::which("npx.cmd"))
        .ok()?;
    probe_runtime(&node, &npx).await
}

fn status_from(
    managed_dir: Option<String>,
    managed: Option<FoundRuntime>,
    system: Option<FoundRuntime>,
) -> NodeRuntimeStatus {
    let (source, active) = if let Some(found) = managed {
        (Some("managed".to_string()), Some(found))
    } else if let Some(found) = system {
        (Some("system".to_string()), Some(found))
    } else {
        (None, None)
    };
    NodeRuntimeStatus {
        available: active.is_some(),
        source,
        version: active.as_ref().map(|found| found.version.clone()),
        node_path: active.as_ref().map(|found| found.node_path.clone()),
        npx_path: active.as_ref().map(|found| found.npx_path.clone()),
        managed_dir,
    }
}

#[tauri::command]
pub async fn check_node_runtime() -> Result<NodeRuntimeStatus, String> {
    let layout = NodeLayout::resolve()?;
    let managed_dir = if layout.root.exists() {
        Some(layout.root.to_string_lossy().into_owned())
    } else {
        None
    };
    let managed = managed_runtime(&layout).await;
    let system = if managed.is_some() {
        None
    } else {
        system_runtime().await
    };
    Ok(status_from(managed_dir, managed, system))
}

#[tauri::command]
pub async fn remove_node_runtime() -> Result<(), String> {
    let layout = NodeLayout::resolve()?;
    let parent = layout
        .root
        .parent()
        .ok_or_else(|| "Node.js runtime path has no parent.".to_string())?;
    for path in [
        layout.root.clone(),
        parent.join("node.partial"),
        parent.join("node.previous"),
    ] {
        ensure_inside_home(&layout, &path)?;
        remove_tree(&path)?;
    }
    Ok(())
}

fn try_begin_node_install() -> Result<NodeInstallGuard, String> {
    if NODE_INSTALL_IN_PROGRESS
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(ALREADY_INSTALLING.to_string());
    }
    Ok(NodeInstallGuard)
}

#[derive(Debug)]
struct NodeInstallGuard;

impl Drop for NodeInstallGuard {
    fn drop(&mut self) {
        NODE_INSTALL_IN_PROGRESS.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub async fn install_node_runtime(window: WebviewWindow) -> Result<(), String> {
    let guard = try_begin_node_install()?;
    tokio::spawn(async move {
        let _guard = guard;
        let success = match install_managed(&window).await {
            Ok(()) => true,
            Err(err) => {
                let _ = window.emit("node-runtime-install-output", err);
                false
            }
        };
        let _ = window.emit("node-runtime-install-complete", success);
    });
    Ok(())
}

async fn install_managed(window: &WebviewWindow) -> Result<(), String> {
    let layout = NodeLayout::resolve()?;
    let parent = layout
        .root
        .parent()
        .ok_or_else(|| "Node.js runtime path has no parent.".to_string())?
        .to_path_buf();
    ensure_inside_home(&layout, &layout.root)?;
    std::fs::create_dir_all(&parent)
        .map_err(|err| format!("Failed to create {}: {err}", parent.display()))?;

    let emit = |line: String| {
        let _ = window.emit("node-runtime-install-output", line);
    };
    emit("Resolving the Node.js LTS release...".to_string());
    let client = node_download_client()?;
    let index = download_limited(&client, INDEX_URL, MAX_INDEX_BYTES).await?;
    let index_text = String::from_utf8(index)
        .map_err(|_| "Node.js release index was not valid UTF-8.".to_string())?;
    let version = select_lts_version(&index_text)?;
    let (os, arch) = (pinned_install::current_os(), pinned_install::current_arch());
    let asset = node_dist_asset(os, arch, &version)?;
    emit(format!("Downloading {}...", asset.filename));
    // Checksums come from the same TLS host as the archive. There is no
    // separate GPG signature; see the module comment for that threat model.
    let sums = download_limited(&client, &asset.shasums_url, MAX_SUMS_BYTES).await?;
    let sums_text =
        String::from_utf8(sums).map_err(|_| "SHASUMS256.txt was not valid UTF-8.".to_string())?;
    let expected = expected_sha256(&sums_text, &asset.filename)?;
    let archive = download_limited(&client, &asset.url, MAX_ARCHIVE_BYTES).await?;
    emit("Verifying SHA-256 against SHASUMS256.txt...".to_string());
    verify_sha256(&archive, &expected)?;

    let partial = parent.join("node.partial");
    ensure_inside_home(&layout, &partial)?;
    emit(format!("Extracting into {}", layout.root.display()));
    extract_verified_archive(&archive, asset.kind, &partial)?;
    swap_runtime(&layout, &partial)?;
    emit(format!("Node.js {} installed.", asset.version));
    Ok(())
}

fn swap_runtime(layout: &NodeLayout, partial: &Path) -> Result<(), String> {
    let parent = layout
        .root
        .parent()
        .ok_or_else(|| "Node.js runtime path has no parent.".to_string())?;
    let previous = parent.join("node.previous");
    ensure_inside_home(layout, &layout.root)?;
    ensure_inside_home(layout, partial)?;
    ensure_inside_home(layout, &previous)?;
    remove_tree(&previous)?;
    if layout.root.exists() {
        // A locked node.exe makes this rename fail on Windows. Leave the live
        // tree in place so a failed swap can still roll forward later.
        rename_path(&layout.root, &previous).map_err(|err| {
            format!(
                "Failed to move the existing Node.js runtime aside: {err}. The current copy was left in place."
            )
        })?;
    }
    if let Err(err) = rename_path(partial, &layout.root) {
        if previous.exists() {
            let _ = rename_path(&previous, &layout.root);
        }
        return Err(format!(
            "Failed to move the Node.js runtime into place: {err}"
        ));
    }
    let _ = remove_tree(&previous);
    Ok(())
}

pub(crate) fn extract_verified_archive(
    bytes: &[u8],
    kind: ArchiveKind,
    dest: &Path,
) -> Result<(), String> {
    reset_directory(dest)?;
    let extracted = match kind {
        ArchiveKind::TarGz => extract_tar_bytes(&decode_gzip(bytes)?, dest),
        ArchiveKind::TarXz => extract_tar_bytes(&decode_xz(bytes)?, dest),
        ArchiveKind::Zip => extract_zip(bytes, dest),
    };
    if let Err(err) = extracted {
        let _ = remove_tree(dest);
        return Err(err);
    }
    if runtime_bin_dir(dest).is_none() {
        let _ = remove_tree(dest);
        return Err("Archive did not contain node and npx.".to_string());
    }
    Ok(())
}

fn decode_gzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = GzDecoder::new(Cursor::new(bytes));
    let mut output = Vec::new();
    copy_limited(&mut decoder, &mut output, MAX_EXTRACTED_BYTES)?;
    Ok(output)
}

fn decode_xz(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut input = Cursor::new(bytes);
    let mut output = Vec::new();
    let mut limited = LimitedWriter {
        output: &mut output,
        max_bytes: MAX_EXTRACTED_BYTES,
    };
    lzma_rs::xz_decompress(&mut input, &mut limited)
        .map_err(|err| format!("Failed to decompress xz archive: {err}"))?;
    Ok(output)
}

struct LimitedWriter<'a> {
    output: &'a mut Vec<u8>,
    max_bytes: usize,
}

impl Write for LimitedWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.output.len().saturating_add(buf.len()) > self.max_bytes {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Archive expands beyond the size limit.",
            ));
        }
        self.output.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn copy_limited(
    reader: &mut impl Read,
    output: &mut Vec<u8>,
    max_bytes: usize,
) -> Result<(), String> {
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|err| format!("Failed to read archive: {err}"))?;
        if read == 0 {
            break;
        }
        if output.len() + read > max_bytes {
            return Err("Archive expands beyond the size limit.".to_string());
        }
        output.extend_from_slice(&buffer[..read]);
    }
    Ok(())
}

fn extract_tar_bytes(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let mut archive = tar::Archive::new(Cursor::new(bytes));
    archive.set_preserve_permissions(false);
    archive.set_unpack_xattrs(false);
    let mut expected_root: Option<String> = None;
    let mut total = 0usize;
    let entries = archive
        .entries()
        .map_err(|err| format!("Failed to read tarball: {err}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|err| format!("Failed to read tarball entry: {err}"))?;
        let path = entry
            .path()
            .map_err(|err| format!("Failed to read tarball path: {err}"))?
            .into_owned();
        if path.as_os_str().is_empty() {
            continue;
        }
        let (root, rel) = split_dist_root(&path)?;
        remember_root(&mut expected_root, &root)?;
        let kind = entry.header().entry_type();
        if kind.is_gnu_longname()
            || kind.is_gnu_longlink()
            || kind.is_pax_global_extensions()
            || kind.is_pax_local_extensions()
        {
            continue;
        }
        if rel.as_os_str().is_empty() {
            continue;
        }
        if kind.is_dir() {
            create_dir_nofollow(dest, &rel)?;
        } else if kind.is_symlink() {
            let target = entry
                .link_name()
                .map_err(|err| format!("Failed to read symlink target: {err}"))?
                .ok_or_else(|| format!("Symlink {} has no target.", path.display()))?;
            let target = path_to_utf8(&target)?;
            link_target_inside(&rel, &target)?;
            create_symlink_nofollow(dest, &rel, &target)?;
        } else if kind.is_hard_link() {
            return Err(format!("Refusing hard link {}", path.display()));
        } else if kind.is_file() {
            let mut bytes = Vec::new();
            copy_limited(&mut entry, &mut bytes, MAX_ENTRY_BYTES)?;
            total = add_total(total, bytes.len())?;
            let mode = entry.header().mode().unwrap_or(0o644);
            write_file_nofollow(dest, &rel, &bytes, mode)?;
        } else {
            return Err(format!(
                "Refusing unsupported archive entry {}",
                path.display()
            ));
        }
    }
    if expected_root.is_none() {
        return Err("Archive was empty.".to_string());
    }
    Ok(())
}

fn extract_zip(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|err| format!("Failed to read zip archive: {err}"))?;
    let mut expected_root: Option<String> = None;
    let mut total = 0usize;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| format!("Failed to read zip entry: {err}"))?;
        let name = entry.name().to_string();
        if name.is_empty() {
            continue;
        }
        let path = PathBuf::from(&name);
        let (root, rel) = split_dist_root(&path)?;
        remember_root(&mut expected_root, &root)?;
        if rel.as_os_str().is_empty() {
            continue;
        }
        let mode = entry.unix_mode();
        if zip_is_symlink(mode) {
            let mut target = String::new();
            entry
                .read_to_string(&mut target)
                .map_err(|err| format!("Failed to read zip symlink: {err}"))?;
            if target.len() > MAX_PATH_CHARS {
                return Err("Refusing an oversized symlink target.".to_string());
            }
            link_target_inside(&rel, target.trim_end_matches('\0'))?;
            create_symlink_nofollow(dest, &rel, target.trim_end_matches('\0'))?;
            continue;
        }
        if entry.is_dir() || name.ends_with('/') {
            create_dir_nofollow(dest, &rel)?;
            continue;
        }
        let mut bytes = Vec::new();
        copy_limited(&mut entry, &mut bytes, MAX_ENTRY_BYTES)?;
        total = add_total(total, bytes.len())?;
        write_file_nofollow(dest, &rel, &bytes, mode.unwrap_or(0o644))?;
    }
    if expected_root.is_none() {
        return Err("Archive was empty.".to_string());
    }
    Ok(())
}

fn zip_is_symlink(mode: Option<u32>) -> bool {
    mode.is_some_and(|mode| mode & 0o170000 == 0o120000)
}

fn add_total(total: usize, next: usize) -> Result<usize, String> {
    let summed = total.saturating_add(next);
    if summed > MAX_EXTRACTED_BYTES {
        return Err("Archive expands beyond the size limit.".to_string());
    }
    Ok(summed)
}

fn remember_root(expected: &mut Option<String>, root: &str) -> Result<(), String> {
    match expected {
        Some(current) if current != root => Err(format!(
            "Archive mixes top-level directories {current} and {root}."
        )),
        Some(_) => Ok(()),
        None => {
            *expected = Some(root.to_string());
            Ok(())
        }
    }
}

fn split_dist_root(path: &Path) -> Result<(String, PathBuf), String> {
    let parts = safe_path_parts(path)?;
    let mut parts = parts.into_iter();
    let root = parts
        .next()
        .ok_or_else(|| format!("Refusing archive path {}", path.display()))?;
    Ok((root, parts.collect()))
}

fn safe_path_parts(path: &Path) -> Result<Vec<String>, String> {
    if path.as_os_str().is_empty() {
        return Err("Refusing an empty archive path.".to_string());
    }
    let rendered = path.to_string_lossy();
    if rendered.len() > MAX_PATH_CHARS || rendered.contains('\0') {
        return Err(format!("Refusing archive path {rendered}."));
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let text = part
                    .to_str()
                    .ok_or_else(|| format!("Refusing non-UTF-8 archive path {rendered}."))?
                    .to_string();
                if text.is_empty()
                    || text == "."
                    || text == ".."
                    || text.contains('/')
                    || text.contains('\\')
                {
                    return Err(format!("Refusing archive path {rendered}."));
                }
                parts.push(text);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("Refusing archive path {rendered}."));
            }
        }
    }
    if parts.is_empty() {
        return Err(format!("Refusing archive path {rendered}."));
    }
    Ok(parts)
}

pub(crate) fn link_target_inside(link_rel: &Path, target: &str) -> Result<(), String> {
    if target.is_empty() || target.contains('\0') || target.len() > MAX_PATH_CHARS {
        return Err("Refusing an empty or invalid symlink.".to_string());
    }
    if is_absolute_link(target) {
        return Err(format!(
            "Refusing symlink that escapes the runtime directory: {target}"
        ));
    }
    let mut stack: Vec<String> = link_rel
        .parent()
        .unwrap_or(Path::new(""))
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    for part in target.split(['/', '\\']) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if stack.pop().is_none() {
                return Err(format!(
                    "Refusing symlink that escapes the runtime directory: {target}"
                ));
            }
            continue;
        }
        if part.contains(':') {
            return Err(format!(
                "Refusing symlink that escapes the runtime directory: {target}"
            ));
        }
        stack.push(part.to_string());
    }
    Ok(())
}

fn is_absolute_link(target: &str) -> bool {
    let bytes = target.as_bytes();
    bytes
        .first()
        .is_some_and(|byte| *byte == b'/' || *byte == b'\\')
        || bytes.get(1) == Some(&b':')
}

fn path_to_utf8(path: &Path) -> Result<String, String> {
    path.to_str()
        .filter(|text| !text.contains('\0'))
        .map(str::to_string)
        .ok_or_else(|| format!("Refusing non-UTF-8 symlink {}", path.display()))
}

fn create_dir_nofollow(dest: &Path, rel: &Path) -> Result<(), String> {
    let mut current = dest.to_path_buf();
    for component in rel.components() {
        let Component::Normal(name) = component else {
            return Err("Refusing an unsafe directory path.".to_string());
        };
        current.push(name);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!("Refusing to follow symlink {}", current.display()));
            }
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => {
                return Err(format!("{} is not a directory.", current.display()));
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current)
                    .map_err(|err| format!("Failed to create {}: {err}", current.display()))?;
            }
            Err(err) => return Err(format!("Failed to inspect {}: {err}", current.display())),
        }
    }
    Ok(())
}

fn ensure_real_parents(dest: &Path, rel: &Path) -> Result<(), String> {
    let mut current = dest.to_path_buf();
    let parent = rel.parent().unwrap_or(Path::new(""));
    for component in parent.components() {
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!("Refusing to follow symlink {}", current.display()));
            }
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return Err(format!("{} is not a directory.", current.display())),
            Err(err) => return Err(format!("Missing directory {}: {err}", current.display())),
        }
    }
    Ok(())
}

fn write_file_nofollow(dest: &Path, rel: &Path, bytes: &[u8], mode: u32) -> Result<(), String> {
    if rel.as_os_str().is_empty() {
        return Err("Refusing an empty archive path.".to_string());
    }
    let parent = rel.parent().unwrap_or(Path::new(""));
    if !parent.as_os_str().is_empty() {
        create_dir_nofollow(dest, parent)?;
    }
    ensure_real_parents(dest, rel)?;
    let full = dest.join(rel);
    if let Ok(meta) = std::fs::symlink_metadata(&full) {
        if meta.file_type().is_symlink() {
            return Err(format!(
                "Refusing to write through symlink {}",
                full.display()
            ));
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&full)
        .map_err(|err| format!("Failed to write {}: {err}", full.display()))?;
    file.write_all(bytes)
        .map_err(|err| format!("Failed to write {}: {err}", full.display()))?;
    #[cfg(unix)]
    set_unix_mode(&full, mode)?;
    #[cfg(not(unix))]
    {
        let _ = mode;
    }
    Ok(())
}

#[cfg(unix)]
fn set_unix_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if mode == 0 { 0o644 } else { mode & 0o777 };
    let mut permissions = std::fs::metadata(path)
        .map_err(|err| format!("Failed to stat {}: {err}", path.display()))?
        .permissions();
    permissions.set_mode(mode);
    std::fs::set_permissions(path, permissions)
        .map_err(|err| format!("Failed to set permissions on {}: {err}", path.display()))
}

fn create_symlink_nofollow(dest: &Path, rel: &Path, target: &str) -> Result<(), String> {
    let parent = rel.parent().unwrap_or(Path::new(""));
    if !parent.as_os_str().is_empty() {
        create_dir_nofollow(dest, parent)?;
    }
    ensure_real_parents(dest, rel)?;
    let full = dest.join(rel);
    if std::fs::symlink_metadata(&full).is_ok() {
        return Err(format!("Refusing to replace {}", full.display()));
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, &full)
            .map_err(|err| format!("Failed to create symlink {}: {err}", full.display()))?;
        Ok(())
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(target, &full)
            .map_err(|err| format!("Failed to create symlink {}: {err}", full.display()))?;
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, full);
        Err("Symlinks are not supported on this platform.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;

    #[cfg(unix)]
    fn write_runnable_node(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, b"#!/bin/sh\necho v22.14.0\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn restore_env(key: &str, previous: Option<String>) {
        match previous {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }

    fn with_temp_home<T>(run: impl FnOnce(&Path) -> T) -> T {
        let _guard = crate::providers::paths::lock_provider_env();
        let dir = tempfile::TempDir::new().unwrap();
        let previous = std::env::var("LOCALPRISM_HOME").ok();
        std::env::set_var("LOCALPRISM_HOME", dir.path());
        let result = run(dir.path());
        restore_env("LOCALPRISM_HOME", previous);
        result
    }

    #[test]
    fn selects_official_archive_for_each_desktop_target() {
        let cases = [
            (
                "windows",
                "x86_64",
                ArchiveKind::Zip,
                "node-v22.14.0-win-x64.zip",
            ),
            (
                "windows",
                "aarch64",
                ArchiveKind::Zip,
                "node-v22.14.0-win-arm64.zip",
            ),
            (
                "macos",
                "x86_64",
                ArchiveKind::TarGz,
                "node-v22.14.0-darwin-x64.tar.gz",
            ),
            (
                "macos",
                "aarch64",
                ArchiveKind::TarGz,
                "node-v22.14.0-darwin-arm64.tar.gz",
            ),
            (
                "linux",
                "x86_64",
                ArchiveKind::TarXz,
                "node-v22.14.0-linux-x64.tar.xz",
            ),
            (
                "linux",
                "aarch64",
                ArchiveKind::TarXz,
                "node-v22.14.0-linux-arm64.tar.xz",
            ),
        ];
        for (os, arch, kind, filename) in cases {
            let asset = node_dist_asset(os, arch, "22.14.0").unwrap();
            assert_eq!(asset.kind, kind);
            assert_eq!(asset.version, "v22.14.0");
            assert_eq!(asset.filename, filename);
            assert_eq!(
                asset.url,
                format!("https://nodejs.org/dist/v22.14.0/{filename}")
            );
            assert_eq!(
                asset.shasums_url,
                "https://nodejs.org/dist/v22.14.0/SHASUMS256.txt"
            );
        }
        assert!(node_dist_asset("freebsd", "x86_64", "v22.14.0").is_err());
        assert!(node_dist_asset("linux", "x86", "v22.14.0").is_err());
    }

    #[test]
    fn selects_the_newest_lts_release() {
        let index = r#"[
            {"version":"v24.0.0","lts":false},
            {"version":"v22.14.0","lts":"Jod"},
            {"version":"v22.13.1","lts":true},
            {"version":"v20.18.0","lts":"Iron"}
        ]"#;
        assert_eq!(select_lts_version(index).unwrap(), "v22.14.0");
        assert!(select_lts_version(r#"[{"version":"v24.0.0","lts":false}]"#).is_err());
    }

    #[test]
    fn verifies_sha256_against_shasums256() {
        let bytes = b"node-archive";
        let hash = sha256_hex(bytes);
        let sums = format!(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  other.tar.xz\n{hash}  node-v22.14.0-linux-x64.tar.xz\n"
        );
        assert_eq!(
            expected_sha256(&sums, "node-v22.14.0-linux-x64.tar.xz").unwrap(),
            hash
        );
        verify_sha256(bytes, &hash).unwrap();
        assert!(verify_sha256(b"tampered", &hash).is_err());
        assert!(expected_sha256(&sums, "../node-v22.14.0-linux-x64.tar.xz").is_err());
        assert!(expected_sha256(&sums, "missing.tar.xz").is_err());
    }

    #[test]
    fn prepends_managed_node_without_changing_process_path() {
        let before = std::env::var("PATH").ok();
        assert_eq!(
            prepend_path_entry("/usr/bin:/bin", "/opt/node/bin", ":"),
            "/opt/node/bin:/usr/bin:/bin"
        );
        assert_eq!(
            prepend_path_entry("/opt/node/bin:/usr/bin", "/opt/node/bin", ":"),
            "/opt/node/bin:/usr/bin"
        );
        assert_eq!(
            prepend_path_entry(r"C:\Windows\system32", r"C:\LocalPrism\runtimes\node", ";"),
            r"C:\LocalPrism\runtimes\node;C:\Windows\system32"
        );
        assert_eq!(
            prepend_path_entry("/usr/bin:/opt/node/bin:/bin", "/opt/node/bin", ":"),
            "/opt/node/bin:/usr/bin:/bin"
        );
        with_temp_home(|home| {
            let bin = home.join("runtimes").join("node").join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::write(bin.join("node"), b"not-a-program").unwrap();
            std::fs::write(bin.join("npx"), b"npx").unwrap();
            assert_eq!(prepend_managed_node_path("/usr/bin"), "/usr/bin");
            #[cfg(unix)]
            {
                write_runnable_node(&bin.join("node"));
                let path = prepend_managed_node_path("/usr/bin");
                assert_eq!(path, format!("{}:/usr/bin", bin.display()));
            }
            assert_eq!(std::env::var("PATH").ok(), before);
        });
        assert_eq!(std::env::var("PATH").ok(), before);
    }

    #[test]
    fn missing_managed_runtime_leaves_child_path_unchanged() {
        with_temp_home(|_| {
            let current = std::env::var("PATH").unwrap_or_default();
            assert_eq!(prepend_managed_node_path(&current), current);
        });
    }

    #[test]
    fn rejects_symlink_targets_that_escape_and_keeps_internal_ones() {
        link_target_inside(
            Path::new("bin/npx"),
            "../lib/node_modules/npm/bin/npx-cli.js",
        )
        .unwrap();
        assert!(link_target_inside(Path::new("bin/npx"), "../../outside").is_err());
        assert!(link_target_inside(Path::new("bin/npx"), "/tmp/evil").is_err());
        assert!(
            link_target_inside(Path::new("npx.cmd"), r"..\..\windows\system32\cmd.exe").is_err()
        );
    }

    #[test]
    fn extraction_rejects_path_traversal_and_escaping_symlinks() {
        let dest = tempfile::TempDir::new().unwrap();
        let outside = dest.path().join("outside.txt");
        let root = dest.path().join("runtime");
        let traversal = gzip_bytes(&tar_with_forced_name("node-v1/../../outside.txt", b"nope"));
        let traversal_error =
            extract_verified_archive(&traversal, ArchiveKind::TarGz, &root).unwrap_err();
        assert!(traversal_error.contains("Refusing"), "{traversal_error}");
        assert!(!outside.exists());

        let link = tar_gz(&[
            TarItem::File {
                path: "node-v1/bin/node",
                bytes: b"node",
                mode: 0o755,
            },
            TarItem::Symlink {
                path: "node-v1/bin/npx",
                target: "../../outside",
            },
        ]);
        assert!(extract_verified_archive(&link, ArchiveKind::TarGz, &root).is_err());
        assert!(!outside.exists());
        assert!(!root.join("bin").join("npx").exists());
    }

    #[test]
    fn extraction_allows_an_internal_npx_symlink() {
        let dest = tempfile::TempDir::new().unwrap();
        let archive = tar_gz(&[
            TarItem::File {
                path: "node-v1/bin/node",
                bytes: b"#!/bin/sh\necho v22.14.0\n",
                mode: 0o755,
            },
            TarItem::File {
                path: "node-v1/lib/npx-cli.js",
                bytes: b"npx",
                mode: 0o644,
            },
            TarItem::Symlink {
                path: "node-v1/bin/npx",
                target: "../lib/npx-cli.js",
            },
        ]);
        extract_verified_archive(&archive, ArchiveKind::TarGz, dest.path()).unwrap();
        let link = dest.path().join("bin").join("npx");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_link(&link).unwrap(),
            PathBuf::from("../lib/npx-cli.js")
        );
        assert!(dest.path().join("bin").join("node").is_file());
    }

    #[test]
    fn zip_extraction_rejects_traversal_and_keeps_windows_commands() {
        let dest = tempfile::TempDir::new().unwrap();
        let outside = dest.path().parent().unwrap().join("zip-outside.txt");
        let bad = zip_bytes(&[("node-v1/../../zip-outside.txt", b"nope".as_slice())]);
        assert!(extract_verified_archive(&bad, ArchiveKind::Zip, dest.path()).is_err());
        assert!(!outside.exists());

        let good = zip_bytes(&[
            ("node-v1/node.exe", b"node"),
            ("node-v1/npx.cmd", b"@echo off\r\n"),
        ]);
        extract_verified_archive(&good, ArchiveKind::Zip, dest.path()).unwrap();
        assert!(dest.path().join("node.exe").is_file());
        assert!(dest.path().join("npx.cmd").is_file());
    }

    #[test]
    fn xz_archive_extracts_linux_layout() {
        let dest = tempfile::TempDir::new().unwrap();
        let raw = tar_bytes(&[
            TarItem::File {
                path: "node-v1/bin/node",
                bytes: b"node",
                mode: 0o755,
            },
            TarItem::File {
                path: "node-v1/bin/npx",
                bytes: b"npx",
                mode: 0o755,
            },
        ]);
        let mut encoded = Vec::new();
        lzma_rs::xz_compress(&mut Cursor::new(raw), &mut encoded).unwrap();
        extract_verified_archive(&encoded, ArchiveKind::TarXz, dest.path()).unwrap();
        assert!(dest.path().join("bin").join("node").is_file());
        assert!(dest.path().join("bin").join("npx").is_file());
    }

    #[test]
    fn windows_layout_is_the_runtime_root_but_a_broken_copy_is_not_prepended() {
        with_temp_home(|home| {
            let root = home.join("runtimes").join("node");
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(root.join("node.exe"), b"node").unwrap();
            std::fs::write(root.join("npx.cmd"), b"npx").unwrap();
            assert_eq!(runtime_bin_dir(&root).as_deref(), Some(root.as_path()));
            assert_eq!(prepend_managed_node_path(r"C:\Windows"), r"C:\Windows");
        });
    }

    #[test]
    fn absolute_app_data_paths_stay_inside_home_on_every_desktop() {
        let linux_home = "/home/user/.config/LocalPrism";
        let macos_home = "/Users/user/Library/Application Support/LocalPrism";
        let windows_home = r"C:\Users\user\AppData\Roaming\LocalPrism";
        assert!(runtime_path_inside_home(
            "/home/user/.config/LocalPrism/runtimes/node",
            linux_home,
            false,
        ));
        assert!(runtime_path_inside_home(
            "/home/user/.config/LocalPrism/runtimes/node.partial",
            linux_home,
            false,
        ));
        assert!(runtime_path_inside_home(
            "/Users/user/Library/Application Support/LocalPrism/runtimes/node",
            macos_home,
            false,
        ));
        assert!(runtime_path_inside_home(
            "/Users/user/Library/Application Support/LocalPrism/runtimes/node.previous",
            macos_home,
            false,
        ));
        for path in [
            r"C:\Users\user\AppData\Roaming\LocalPrism\runtimes\node",
            r"\\?\C:\Users\user\AppData\Roaming\LocalPrism\runtimes\node",
            r"c:\users\user\appdata\roaming\localprism\runtimes\node.partial",
        ] {
            assert!(runtime_path_inside_home(path, windows_home, true), "{path}");
        }
        assert!(runtime_path_inside_home(
            r"\\?\UNC\server\share\LocalPrism\runtimes\node",
            r"\\server\share\LocalPrism",
            true,
        ));
        assert!(!runtime_path_inside_home(linux_home, linux_home, false));
        assert!(!runtime_path_inside_home(
            "/home/user/.config/LocalPrism-extra/runtimes/node",
            linux_home,
            false,
        ));
        assert!(!runtime_path_inside_home(
            "/home/user/.config/LocalPrism/runtimes/../../etc",
            linux_home,
            false,
        ));
        assert!(!runtime_path_inside_home(
            r"C:\Users\user\AppData\Roaming\LocalPrism\..\Windows",
            windows_home,
            true,
        ));
        assert!(!runtime_path_inside_home(
            r"D:\LocalPrism\runtimes\node",
            windows_home,
            true,
        ));
        assert!(!runtime_path_inside_home(
            r"c:\users\user\appdata\roaming\localprism\runtimes\node",
            windows_home,
            false,
        ));
    }

    #[test]
    fn real_absolute_home_can_prepare_swap_and_remove_the_runtime() {
        with_temp_home(|home| {
            let layout = NodeLayout::resolve().unwrap();
            assert!(layout.home.is_absolute());
            assert!(layout.root.is_absolute());
            assert!(layout
                .root
                .components()
                .any(|component| matches!(component, Component::RootDir)));
            ensure_inside_home(&layout, &layout.root).unwrap();
            let parent = layout.root.parent().unwrap();
            let partial = parent.join("node.partial");
            let previous = parent.join("node.previous");
            ensure_inside_home(&layout, &partial).unwrap();
            ensure_inside_home(&layout, &previous).unwrap();
            assert!(ensure_inside_home(&layout, home).is_err());
            assert!(ensure_inside_home(&layout, &home.join("..").join("outside")).is_err());

            std::fs::create_dir_all(partial.join("bin")).unwrap();
            std::fs::write(partial.join("bin").join("node"), b"new").unwrap();
            std::fs::create_dir_all(&layout.root).unwrap();
            std::fs::write(layout.root.join("old.txt"), b"old").unwrap();
            swap_runtime(&layout, &partial).unwrap();
            assert_eq!(
                std::fs::read(layout.root.join("bin").join("node")).unwrap(),
                b"new"
            );
            assert!(!layout.root.join("old.txt").exists());
            assert!(!partial.exists());

            std::fs::create_dir_all(parent.join("node.partial")).unwrap();
            std::fs::write(parent.join("node.previous"), b"stale").unwrap();
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(remove_node_runtime())
                .unwrap();
            assert!(!layout.root.exists());
            assert!(!parent.join("node.partial").exists());
            assert!(!parent.join("node.previous").exists());
            assert!(home.exists());
        });
    }

    #[test]
    fn swap_keeps_the_live_runtime_when_it_cannot_be_moved_aside() {
        with_temp_home(|_| {
            let layout = NodeLayout::resolve().unwrap();
            std::fs::create_dir_all(&layout.root).unwrap();
            std::fs::write(layout.root.join("keep.txt"), b"live").unwrap();
            let partial = layout.root.parent().unwrap().join("node.partial");
            std::fs::create_dir_all(&partial).unwrap();
            std::fs::write(partial.join("new.txt"), b"new").unwrap();
            FAIL_ROOT_RENAME.with(|flag| flag.set(true));
            let error = swap_runtime(&layout, &partial).unwrap_err();
            FAIL_ROOT_RENAME.with(|flag| flag.set(false));
            assert!(error.contains("left in place"), "{error}");
            assert_eq!(
                std::fs::read(layout.root.join("keep.txt")).unwrap(),
                b"live"
            );
            assert!(partial.join("new.txt").is_file());
            assert!(!layout.root.parent().unwrap().join("node.previous").exists());
        });
    }

    #[test]
    fn a_second_install_does_not_start_while_one_is_running() {
        let first = try_begin_node_install().unwrap();
        let second = try_begin_node_install().unwrap_err();
        assert!(second.contains("already running"));
        drop(first);
        let third = try_begin_node_install().unwrap();
        drop(third);
        assert!(!NODE_INSTALL_IN_PROGRESS.load(Ordering::Acquire));
    }

    #[test]
    fn node_downloads_stay_on_https_nodejs_org() {
        official_node_download_url("https://nodejs.org/dist/index.json").unwrap();
        official_node_download_url("https://nodejs.org/dist/v22.14.0/SHASUMS256.txt").unwrap();
        assert!(official_node_download_url("http://nodejs.org/dist/index.json").is_err());
        assert!(official_node_download_url("https://evil.example/node.tar.xz").is_err());
        assert!(official_node_download_url("https://nodejs.org.evil.com/dist/index.json").is_err());
        assert!(official_node_download_url("https://user:pass@nodejs.org/dist/index.json").is_ok());
    }

    #[test]
    fn managed_choice_wins_over_system_node() {
        let managed = FoundRuntime {
            version: "v22.14.0".to_string(),
            node_path: "/data/runtimes/node/bin/node".to_string(),
            npx_path: "/data/runtimes/node/bin/npx".to_string(),
        };
        let system = FoundRuntime {
            version: "v20.0.0".to_string(),
            node_path: "/usr/bin/node".to_string(),
            npx_path: "/usr/bin/npx".to_string(),
        };
        let status = status_from(
            Some("/data/runtimes/node".to_string()),
            Some(managed),
            Some(system.clone()),
        );
        assert_eq!(status.source.as_deref(), Some("managed"));
        assert_eq!(status.version.as_deref(), Some("v22.14.0"));
        assert_eq!(
            status.node_path.as_deref(),
            Some("/data/runtimes/node/bin/node")
        );

        let fallback = status_from(None, None, Some(system));
        assert_eq!(fallback.source.as_deref(), Some("system"));
        assert!(fallback.managed_dir.is_none());

        let missing = status_from(None, None, None);
        assert!(!missing.available);
        assert!(missing.source.is_none());
    }

    enum TarItem {
        File {
            path: &'static str,
            bytes: &'static [u8],
            mode: u32,
        },
        Symlink {
            path: &'static str,
            target: &'static str,
        },
    }

    fn tar_bytes(items: &[TarItem]) -> Vec<u8> {
        let mut raw = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut raw);
            for item in items {
                match item {
                    TarItem::File { path, bytes, mode } => {
                        let mut header = tar::Header::new_gnu();
                        header.set_mode(*mode);
                        header.set_size(bytes.len() as u64);
                        header.set_cksum();
                        builder.append_data(&mut header, path, *bytes).unwrap();
                    }
                    TarItem::Symlink { path, target } => {
                        let mut header = tar::Header::new_gnu();
                        header.set_entry_type(tar::EntryType::new(b'2'));
                        header.set_mode(0o777);
                        header.set_size(0);
                        header.set_path(path).unwrap();
                        header.set_link_name(target).unwrap();
                        header.set_cksum();
                        builder.append(&header, std::io::empty()).unwrap();
                    }
                }
            }
            builder.finish().unwrap();
        }
        raw
    }

    fn tar_gz(items: &[TarItem]) -> Vec<u8> {
        gzip_bytes(&tar_bytes(items))
    }

    fn gzip_bytes(raw: &[u8]) -> Vec<u8> {
        let mut encoded = Vec::new();
        let mut encoder = GzEncoder::new(&mut encoded, Compression::default());
        encoder.write_all(raw).unwrap();
        encoder.finish().unwrap();
        encoded
    }

    /// The tar crate refuses to *write* `..`, so the traversal fixture patches
    /// the header name after the checksum is calculated.
    fn tar_with_forced_name(name: &str, contents: &[u8]) -> Vec<u8> {
        assert!(name.len() < 100);
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o644);
        header.set_size(contents.len() as u64);
        header.set_path("node-v1/file.txt").unwrap();
        header.set_cksum();
        let mut bytes = *header.as_bytes();
        bytes[..100].fill(0);
        bytes[..name.len()].copy_from_slice(name.as_bytes());
        bytes[148..156].fill(b' ');
        let sum: u32 = bytes.iter().map(|byte| u32::from(*byte)).sum();
        let rendered = format!("{sum:06o}\0 ");
        bytes[148..156].copy_from_slice(rendered.as_bytes());

        let mut archive = bytes.to_vec();
        archive.extend_from_slice(contents);
        let padding = (512 - (contents.len() % 512)) % 512;
        archive.extend(std::iter::repeat(0).take(padding));
        archive.extend(std::iter::repeat(0).take(1024));
        archive
    }

    fn zip_bytes(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, bytes) in files {
                writer.start_file(*name, options).unwrap();
                writer.write_all(bytes).unwrap();
            }
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }
}
