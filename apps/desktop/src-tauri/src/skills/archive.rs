use crate::skills::fetch::ExtractLimits;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use zip::ZipArchive;

pub(crate) fn is_zip_archive(path: &Path) -> bool {
    extension_is(path, "zip")
}

pub(crate) fn is_tar_gz_archive(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    name.ends_with(".tar.gz") || name.ends_with(".tgz")
}

pub(crate) fn is_skill_archive(path: &Path) -> bool {
    path.is_file() && (is_zip_archive(path) || is_tar_gz_archive(path))
}

fn extension_is(path: &Path, expected: &str) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(expected))
}

/// Extract a local `.zip` or `.tar.gz` into `workspace` and return the directory to scan.
///
/// Zip entries are rejected before any file is written when a path escapes the
/// destination, a symlink is present, or the declared size exceeds the limits.
pub(crate) fn extract_skill_archive(
    archive: &Path,
    workspace: &Path,
    limits: ExtractLimits,
) -> Result<PathBuf, String> {
    fs::create_dir_all(workspace)
        .map_err(|error| format!("Failed to create archive workspace: {error}"))?;
    if is_zip_archive(archive) {
        // `root` is ignored when naming a skill whose SKILL.md sits at the archive root.
        let dest = workspace.join("root");
        if dest.exists() {
            fs::remove_dir_all(&dest)
                .map_err(|error| format!("Failed to clear archive workspace: {error}"))?;
        }
        fs::create_dir_all(&dest)
            .map_err(|error| format!("Failed to create archive workspace: {error}"))?;
        extract_zip(archive, &dest, limits)?;
        return Ok(dest);
    }
    if is_tar_gz_archive(archive) {
        let bytes = read_limited(archive, limits.max_bytes)?;
        super::unpack_tarball_with_limits(&bytes, workspace, None, limits)?;
        return Ok(workspace.join("repo"));
    }
    Err("Choose a .zip or .tar.gz skill archive.".into())
}

fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    if metadata.len() > limit {
        return Err(format!("Archive exceeded the {limit} byte limit"));
    }
    let mut file =
        File::open(path).map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
    let mut bytes = Vec::new();
    let mut remaining = limit;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        if (read as u64) > remaining {
            return Err(format!("Archive exceeded the {limit} byte limit"));
        }
        remaining -= read as u64;
        bytes.extend_from_slice(&buffer[..read]);
    }
    Ok(bytes)
}

struct PlannedZipEntry {
    index: usize,
    relative: PathBuf,
    is_dir: bool,
}

fn extract_zip(archive_path: &Path, dest: &Path, limits: ExtractLimits) -> Result<(), String> {
    let file = File::open(archive_path)
        .map_err(|error| format!("Failed to open {}: {error}", archive_path.display()))?;
    let archive_len = file
        .metadata()
        .map_err(|error| format!("Failed to read {}: {error}", archive_path.display()))?
        .len();
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Failed to read zip: {error}"))?;
    let planned = plan_zip_entries(&mut archive, archive_len, limits)?;
    let mut written = 0_u64;
    for entry in planned {
        let mut file = archive
            .by_index(entry.index)
            .map_err(|error| format!("Failed to read zip entry: {error}"))?;
        let target = dest.join(&entry.relative);
        if !target.starts_with(dest) {
            return Err(format!(
                "Archive path escapes the extraction directory: {}",
                entry.relative.display()
            ));
        }
        if entry.is_dir {
            fs::create_dir_all(&target)
                .map_err(|error| format!("Failed to create {}: {error}", target.display()))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        }
        let remaining = limits.max_bytes.saturating_sub(written);
        let outfile = File::create(&target)
            .map_err(|error| format!("Failed to create {}: {error}", target.display()))?;
        let mut writer = LimitedWriter {
            inner: outfile,
            remaining,
        };
        let copied = io::copy(&mut file, &mut writer).map_err(|error| {
            if error.kind() == io::ErrorKind::InvalidData {
                format!(
                    "Archive extraction exceeded the {} byte limit",
                    limits.max_bytes
                )
            } else {
                format!("Failed to extract {}: {error}", target.display())
            }
        })?;
        written = written.saturating_add(copied);
        if written > limits.max_bytes {
            return Err(format!(
                "Archive extraction exceeded the {} byte limit",
                limits.max_bytes
            ));
        }
    }
    Ok(())
}

fn plan_zip_entries<R: Read + io::Seek>(
    archive: &mut ZipArchive<R>,
    archive_len: u64,
    limits: ExtractLimits,
) -> Result<Vec<PlannedZipEntry>, String> {
    if archive.len() > limits.max_entries {
        return Err(format!(
            "Archive extraction exceeded the {} entry limit",
            limits.max_entries
        ));
    }
    let mut planned = Vec::new();
    let mut declared_bytes = 0_u64;
    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read zip entry: {error}"))?;
        let name = file.name().to_string();
        if name.is_empty() {
            continue;
        }
        let Some(relative) = file.enclosed_name() else {
            return Err(format!(
                "Archive path escapes the extraction directory: {name}"
            ));
        };
        if relative.as_os_str().is_empty() {
            continue;
        }
        if relative.components().count() > limits.max_depth {
            return Err(format!(
                "Archive extraction exceeded the {} path depth limit",
                limits.max_depth
            ));
        }
        if file.is_symlink() {
            return Err(format!("Archive contains a symlink: {name}"));
        }
        let is_dir = file.is_dir() || name.ends_with('/') || name.ends_with('\\');
        if !is_dir {
            declared_bytes = declared_bytes.saturating_add(file.size());
            if declared_bytes > limits.max_bytes {
                return Err(format!(
                    "Archive extraction exceeded the {} byte limit",
                    limits.max_bytes
                ));
            }
            if declared_bytes > limits.ratio_floor {
                if let Some(max_uncompressed) = archive_len.checked_mul(limits.max_ratio) {
                    if declared_bytes > max_uncompressed {
                        return Err(format!(
                            "Archive extraction exceeded the {}:1 compression ratio limit",
                            limits.max_ratio
                        ));
                    }
                }
            }
        }
        planned.push(PlannedZipEntry {
            index,
            relative,
            is_dir,
        });
    }
    if planned.is_empty() || planned.iter().all(|entry| entry.is_dir) {
        return Err("Failed to extract archive: archive had no usable files".into());
    }
    Ok(planned)
}

struct LimitedWriter<W> {
    inner: W,
    remaining: u64,
}

impl<W: Write> Write for LimitedWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 || (buf.len() as u64) > self.remaining {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Archive extraction exceeded the write byte limit",
            ));
        }
        let written = self.inner.write(buf)?;
        self.remaining = self.remaining.saturating_sub(written as u64);
        if written < buf.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Archive extraction exceeded the write byte limit",
            ));
        }
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;
    use zip::ZipWriter;

    fn write_zip(path: &Path, files: &[(&str, &[u8])]) {
        let file = File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, bytes) in files {
            zip.start_file(*name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    fn tight_limits(max_bytes: u64) -> ExtractLimits {
        ExtractLimits {
            max_bytes,
            max_entries: 20,
            max_depth: 8,
            max_ratio: 4,
            ratio_floor: 16,
        }
    }

    #[test]
    fn zip_extracts_a_root_skill_and_sibling_skill_folders() {
        let temp = tempfile::tempdir().unwrap();
        let root_archive = temp.path().join("root.zip");
        write_zip(
            &root_archive,
            &[(
                "SKILL.md",
                b"---\nname: Root\ndescription: Root skill\n---\n",
            )],
        );
        let root = extract_skill_archive(
            &root_archive,
            &temp.path().join("root-work"),
            ExtractLimits::default(),
        )
        .unwrap();
        assert!(root.join("SKILL.md").is_file());
        let mut root_dirs = Vec::new();
        crate::skills::import::collect_skill_dirs(&root, &mut root_dirs);
        assert_eq!(root_dirs.len(), 1);

        let nested = temp.path().join("nested.zip");
        write_zip(
            &nested,
            &[
                (
                    "alpha/SKILL.md",
                    b"---\nname: Alpha\ndescription: Nested skill\n---\n",
                ),
                (
                    "beta/SKILL.md",
                    b"---\nname: Beta\ndescription: Second skill\n---\n",
                ),
            ],
        );
        let nested_root = extract_skill_archive(
            &nested,
            &temp.path().join("nested-work"),
            ExtractLimits::default(),
        )
        .unwrap();
        let mut dirs = Vec::new();
        crate::skills::import::collect_skill_dirs(&nested_root, &mut dirs);
        let mut names: Vec<_> = dirs
            .iter()
            .map(|dir| {
                dir.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        names.sort();
        assert_eq!(names, vec!["alpha", "beta"]);
    }

    #[test]
    fn zip_slip_writes_nothing_outside_the_destination() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("slip.zip");
        write_zip(
            &archive,
            &[
                ("../outside.txt", b"escaped"),
                ("ok/SKILL.md", b"---\nname: Ok\ndescription: Safe\n---\n"),
            ],
        );
        let workspace = temp.path().join("work");
        let error = extract_skill_archive(&archive, &workspace, ExtractLimits::default())
            .expect_err("zip slip must fail");
        assert!(
            error.contains("escapes the extraction directory"),
            "{error}"
        );
        assert!(!temp.path().join("outside.txt").exists());
        assert!(!workspace.join("root/ok/SKILL.md").exists());
    }

    #[test]
    fn zip_rejects_an_absolute_path_before_writing() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("absolute.zip");
        write_zip(&archive, &[("/tmp/localprism-zip-slip.txt", b"nope")]);
        let error = extract_skill_archive(
            &archive,
            &temp.path().join("work"),
            ExtractLimits::default(),
        )
        .expect_err("absolute zip path must fail");
        assert!(
            error.contains("escapes the extraction directory"),
            "{error}"
        );
        assert!(!Path::new("/tmp/localprism-zip-slip.txt").exists());
    }

    #[test]
    fn zip_rejects_entries_over_the_size_limit() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("big.zip");
        let payload = vec![b'a'; 64];
        write_zip(&archive, &[("big/SKILL.md", payload.as_slice())]);
        let error = extract_skill_archive(&archive, &temp.path().join("work"), tight_limits(32))
            .expect_err("oversized zip must fail");
        assert!(error.contains("byte limit"), "{error}");
        assert!(!temp.path().join("work/root/big/SKILL.md").exists());
    }
}
