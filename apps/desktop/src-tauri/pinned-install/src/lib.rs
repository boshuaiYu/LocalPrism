//! Pinned GitHub release assets for Claude CLI and uv.
//!
//! Setup downloads these archives and checks a baked-in SHA-256 before
//! extracting. It never pipes a live installer script into a shell.

use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};

pub const UV_VERSION: &str = "0.12.23";
pub const CLAUDE_VERSION: &str = "2.1.289";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveKind {
    TarGz,
    Zip,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedAsset {
    pub name: &'static str,
    pub version: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub archive: ArchiveKind,
    pub binaries: &'static [&'static str],
}

pub fn uv_asset(os: &str, arch: &str) -> Result<PinnedAsset, String> {
    match (os, arch) {
        ("macos", "aarch64") => Ok(PinnedAsset {
            name: "uv",
            version: UV_VERSION,
            url: "https://github.com/astral-sh/uv/releases/download/0.12.23/uv-aarch64-apple-darwin.tar.gz",
            sha256: "50487ae565ccd96e499056b4674d438f4c53170202617b4c759defe0c6a1b544",
            archive: ArchiveKind::TarGz,
            binaries: &["uv", "uvx"],
        }),
        ("macos", "x86_64") => Ok(PinnedAsset {
            name: "uv",
            version: UV_VERSION,
            url: "https://github.com/astral-sh/uv/releases/download/0.12.23/uv-x86_64-apple-darwin.tar.gz",
            sha256: "960da44cb4b73685206ddd250b19e0a117fa41095710c1038f081f5cb613efb4",
            archive: ArchiveKind::TarGz,
            binaries: &["uv", "uvx"],
        }),
        ("windows", "x86_64") => Ok(PinnedAsset {
            name: "uv",
            version: UV_VERSION,
            url: "https://github.com/astral-sh/uv/releases/download/0.12.23/uv-x86_64-pc-windows-msvc.zip",
            sha256: "75d05de6762778c31ee183398de7dd15093fad0ed90b1f236d8205ea5ec00c90",
            archive: ArchiveKind::Zip,
            binaries: &["uv.exe", "uvx.exe", "uvw.exe"],
        }),
        ("windows", "aarch64") => Ok(PinnedAsset {
            name: "uv",
            version: UV_VERSION,
            url: "https://github.com/astral-sh/uv/releases/download/0.12.23/uv-aarch64-pc-windows-msvc.zip",
            sha256: "13294e232ececbe709c06b74e6ced06f2a225ea5591476685362f22be56a50d5",
            archive: ArchiveKind::Zip,
            binaries: &["uv.exe", "uvx.exe", "uvw.exe"],
        }),
        ("linux", "x86_64") => Ok(PinnedAsset {
            name: "uv",
            version: UV_VERSION,
            url: "https://github.com/astral-sh/uv/releases/download/0.12.23/uv-x86_64-unknown-linux-gnu.tar.gz",
            sha256: "9167d72b3319674b6303c4cbe071854bba13ebdf3d76b1a7cbdc175471fb66d6",
            archive: ArchiveKind::TarGz,
            binaries: &["uv", "uvx"],
        }),
        ("linux", "aarch64") => Ok(PinnedAsset {
            name: "uv",
            version: UV_VERSION,
            url: "https://github.com/astral-sh/uv/releases/download/0.12.23/uv-aarch64-unknown-linux-gnu.tar.gz",
            sha256: "6524bd338177ed50d035d39354e12545e993bbeba2ecbddf0480c5b3a81d313f",
            archive: ArchiveKind::TarGz,
            binaries: &["uv", "uvx"],
        }),
        _ => Err(format!("No pinned uv build for {os}/{arch}.")),
    }
}

pub fn claude_asset(os: &str, arch: &str) -> Result<PinnedAsset, String> {
    match (os, arch) {
        ("macos", "aarch64") => Ok(PinnedAsset {
            name: "claude",
            version: CLAUDE_VERSION,
            url: "https://github.com/anthropics/claude-code/releases/download/v2.1.289/claude-darwin-arm64.tar.gz",
            sha256: "20acfc89a32ed7260b63fd2f3fd71a33de7b2d74b82c724d25941ad73d2e0e96",
            archive: ArchiveKind::TarGz,
            binaries: &["claude"],
        }),
        ("macos", "x86_64") => Ok(PinnedAsset {
            name: "claude",
            version: CLAUDE_VERSION,
            url: "https://github.com/anthropics/claude-code/releases/download/v2.1.289/claude-darwin-x64.tar.gz",
            sha256: "6cef9fa7347447c8f8a025bde024f21f457dad118e3a955da978d285ce5e762e",
            archive: ArchiveKind::TarGz,
            binaries: &["claude"],
        }),
        ("windows", "x86_64") => Ok(PinnedAsset {
            name: "claude",
            version: CLAUDE_VERSION,
            url: "https://github.com/anthropics/claude-code/releases/download/v2.1.289/claude-win32-x64.zip",
            sha256: "fef8293ba9e472a0e69033a4a7742873bc95719d73639e228e82246f696d5935",
            archive: ArchiveKind::Zip,
            binaries: &["claude.exe"],
        }),
        ("windows", "aarch64") => Ok(PinnedAsset {
            name: "claude",
            version: CLAUDE_VERSION,
            url: "https://github.com/anthropics/claude-code/releases/download/v2.1.289/claude-win32-arm64.zip",
            sha256: "877a30fabe916ba0d4a318ada351284a120057b1ea5e42b950ac5fc3716d82e8",
            archive: ArchiveKind::Zip,
            binaries: &["claude.exe"],
        }),
        ("linux", "x86_64") => Ok(PinnedAsset {
            name: "claude",
            version: CLAUDE_VERSION,
            url: "https://github.com/anthropics/claude-code/releases/download/v2.1.289/claude-linux-x64.tar.gz",
            sha256: "aa184fe26777b16e18230da937ffe369e40f261bc65405520cafd7bd95783bef",
            archive: ArchiveKind::TarGz,
            binaries: &["claude"],
        }),
        ("linux", "aarch64") => Ok(PinnedAsset {
            name: "claude",
            version: CLAUDE_VERSION,
            url: "https://github.com/anthropics/claude-code/releases/download/v2.1.289/claude-linux-arm64.tar.gz",
            sha256: "f1dd579805a35402555a833dde1ee509ff6744921dd3f706c82831c7b31cd65f",
            archive: ArchiveKind::TarGz,
            binaries: &["claude"],
        }),
        _ => Err(format!("No pinned Claude CLI build for {os}/{arch}.")),
    }
}

pub fn current_os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        "linux" => "linux",
        other => other,
    }
}

pub fn current_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => other,
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let hashed = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for byte in hashed {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

pub fn verify_sha256(bytes: &[u8], expected_hex: &str) -> Result<(), String> {
    let actual = sha256_hex(bytes);
    let expected = expected_hex.trim().to_ascii_lowercase();
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "Downloaded archive SHA-256 {actual} does not match the pinned digest."
        ))
    }
}

pub fn extract_named_files(
    bytes: &[u8],
    kind: ArchiveKind,
    names: &[&str],
) -> Result<BTreeMap<String, Vec<u8>>, String> {
    match kind {
        ArchiveKind::TarGz => extract_tar_gz(bytes, names),
        ArchiveKind::Zip => extract_zip(bytes, names),
    }
}

const MAX_ARCHIVE_BYTES: usize = 200 * 1024 * 1024;

pub async fn download_verified_archive(
    asset: &PinnedAsset,
    mut on_progress: impl FnMut(String),
) -> Result<Vec<u8>, String> {
    on_progress(format!("Downloading {} {}...", asset.name, asset.version));
    let client = reqwest::Client::builder()
        .user_agent("LocalPrism")
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|err| format!("Failed to start download: {err}"))?;
    let response = client
        .get(asset.url)
        .send()
        .await
        .map_err(|err| format!("Failed to download {}: {err}", asset.name))?;
    if !response.status().is_success() {
        return Err(format!(
            "Failed to download {} ({}).",
            asset.name,
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("Failed to read {}: {err}", asset.name))?;
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(format!("{} archive is too large.", asset.name));
    }
    on_progress(format!("Verifying SHA-256 for {}...", asset.name));
    verify_sha256(&bytes, asset.sha256)?;
    on_progress(format!(
        "SHA-256 verified for {} {}",
        asset.name, asset.version
    ));
    Ok(bytes.to_vec())
}

pub fn install_verified_archive(
    asset: &PinnedAsset,
    archive: &[u8],
    dest_dir: &Path,
) -> Result<PathBuf, String> {
    let files = extract_named_files(archive, asset.archive, asset.binaries)?;
    write_extracted_binaries(dest_dir, &files)
}

pub fn write_extracted_binaries(
    dest_dir: &Path,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dest_dir)
        .map_err(|err| format!("Failed to create install directory: {err}"))?;
    let mut primary = None;
    for (name, contents) in files {
        if !is_safe_file_name(name) {
            return Err(format!("Refusing to install unsafe archive path {name}."));
        }
        let dest = dest_dir.join(name);
        write_binary(&dest, contents)?;
        if primary.is_none() {
            primary = Some(dest);
        }
    }
    primary.ok_or_else(|| "Archive did not contain a recognized binary.".to_string())
}

fn write_binary(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut file = std::fs::File::create(path)
        .map_err(|err| format!("Failed to write {}: {err}", path.display()))?;
    file.write_all(contents)
        .map_err(|err| format!("Failed to write {}: {err}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = file
            .metadata()
            .map_err(|err| format!("Failed to stat {}: {err}", path.display()))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms)
            .map_err(|err| format!("Failed to mark {} executable: {err}", path.display()))?;
    }
    Ok(())
}

fn extract_tar_gz(bytes: &[u8], names: &[&str]) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let decoder = GzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);
    let mut found = BTreeMap::new();
    let entries = archive
        .entries()
        .map_err(|err| format!("Failed to read tarball: {err}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|err| format!("Failed to read tarball entry: {err}"))?;
        let path = entry
            .path()
            .map_err(|err| format!("Failed to read tarball path: {err}"))?
            .into_owned();
        if !is_safe_archive_path(&path) {
            return Err(format!("Refusing archive path {}", path.to_string_lossy()));
        }
        let Some(name) = matching_file_name(&path, names) else {
            continue;
        };
        if found.contains_key(name) {
            continue;
        }
        let mut contents = Vec::new();
        entry
            .read_to_end(&mut contents)
            .map_err(|err| format!("Failed to extract {name}: {err}"))?;
        found.insert(name.to_string(), contents);
    }
    require_primary(names, &found)?;
    Ok(found)
}

fn extract_zip(bytes: &[u8], names: &[&str]) -> Result<BTreeMap<String, Vec<u8>>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|err| format!("Failed to read zip archive: {err}"))?;
    let mut found = BTreeMap::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| format!("Failed to read zip entry: {err}"))?;
        let path = PathBuf::from(entry.name());
        if !is_safe_archive_path(&path) {
            return Err(format!("Refusing archive path {}", path.to_string_lossy()));
        }
        let Some(name) = matching_file_name(&path, names) else {
            continue;
        };
        if found.contains_key(name) {
            continue;
        }
        let mut contents = Vec::new();
        entry
            .read_to_end(&mut contents)
            .map_err(|err| format!("Failed to extract {name}: {err}"))?;
        found.insert(name.to_string(), contents);
    }
    require_primary(names, &found)?;
    Ok(found)
}

fn require_primary(names: &[&str], found: &BTreeMap<String, Vec<u8>>) -> Result<(), String> {
    let primary = names
        .first()
        .ok_or_else(|| "No binary names were requested.".to_string())?;
    if found.contains_key(*primary) {
        Ok(())
    } else {
        Err(format!("Archive did not contain {primary}."))
    }
}

fn matching_file_name<'a>(path: &Path, names: &[&'a str]) -> Option<&'a str> {
    let file_name = path.file_name()?.to_str()?;
    names.iter().copied().find(|name| *name == file_name)
}

fn is_safe_archive_path(path: &Path) -> bool {
    path.components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn is_safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && Path::new(name)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    fn tar_gz(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut raw = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut raw);
            for (name, contents) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(contents.len() as u64);
                header.set_mode(0o755);
                header.set_cksum();
                builder.append_data(&mut header, name, *contents).unwrap();
            }
            builder.finish().unwrap();
        }
        let mut encoded = Vec::new();
        let mut encoder = GzEncoder::new(&mut encoded, Compression::default());
        encoder.write_all(&raw).unwrap();
        encoder.finish().unwrap();
        encoded
    }

    fn zip_bytes(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, contents) in files {
                writer.start_file(*name, options).unwrap();
                writer.write_all(contents).unwrap();
            }
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }

    #[test]
    fn linux_uv_is_a_pinned_github_tarball() {
        let asset = uv_asset("linux", "x86_64").unwrap();
        assert!(asset
            .url
            .starts_with("https://github.com/astral-sh/uv/releases/download/0.12.23/"));
        assert!(!asset.url.contains("astral.sh/uv/install"));
        assert_eq!(asset.sha256.len(), 64);
        assert_eq!(asset.archive, ArchiveKind::TarGz);
    }

    #[test]
    fn windows_claude_is_a_pinned_github_zip() {
        let asset = claude_asset("windows", "x86_64").unwrap();
        assert!(asset
            .url
            .starts_with("https://github.com/anthropics/claude-code/releases/download/v2.1.289/"));
        assert!(!asset.url.contains("claude.ai/install"));
        assert_eq!(asset.archive, ArchiveKind::Zip);
        assert_eq!(asset.binaries, &["claude.exe"]);
    }

    #[test]
    fn verify_sha256_rejects_a_mutated_archive() {
        let bytes = b"not-the-pinned-bytes";
        let digest = sha256_hex(bytes);
        verify_sha256(bytes, &digest).unwrap();
        assert!(verify_sha256(bytes, "ab".repeat(32).as_str()).is_err());
    }

    #[test]
    fn extract_finds_binaries_in_a_subdirectory() {
        let archive = tar_gz(&[("uv-x86_64-unknown-linux-gnu/uv", b"uv-bin")]);
        let files = extract_named_files(&archive, ArchiveKind::TarGz, &["uv"]).unwrap();
        assert_eq!(
            files.get("uv").map(Vec::as_slice),
            Some(b"uv-bin".as_slice())
        );
    }

    #[test]
    fn extract_rejects_path_traversal() {
        assert!(!is_safe_archive_path(Path::new("../uv")));
        assert!(!is_safe_archive_path(Path::new("foo/../../uv")));
        assert!(is_safe_archive_path(Path::new("uv-linux/uv")));
        let archive = zip_bytes(&[("../claude.exe", b"evil")]);
        let error = extract_named_files(&archive, ArchiveKind::Zip, &["claude.exe"]).unwrap_err();
        assert!(error.contains("Refusing archive path"));
    }

    #[test]
    fn zip_extract_requires_the_primary_binary() {
        let archive = zip_bytes(&[("readme.txt", b"hi")]);
        let error = extract_named_files(&archive, ArchiveKind::Zip, &["claude.exe"]).unwrap_err();
        assert!(error.contains("claude.exe"));
    }

    #[test]
    fn write_extracted_binaries_keeps_files_inside_dest() {
        let dir = tempfile::TempDir::new().unwrap();
        let mut files = BTreeMap::new();
        files.insert("uv".to_string(), b"bin".to_vec());
        let dest = write_extracted_binaries(dir.path(), &files).unwrap();
        assert_eq!(dest, dir.path().join("uv"));
        assert_eq!(std::fs::read(dest).unwrap(), b"bin");
    }
}
