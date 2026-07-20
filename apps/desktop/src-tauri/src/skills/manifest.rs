use crate::runtime::RuntimeKind;
use crate::skills::domain::{RuntimeSkill, SkillScope, SkillTarget};
use crate::skills::paths::validate_skill_slug;
use chrono::Utc;
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const SKILL_MANIFEST_VERSION: u32 = 1;
const MANIFEST_DIRECTORY: &str = "ClaudePrism";
const MANIFEST_FILENAME: &str = "skills-manifest.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillManifest {
    pub version: u32,
    pub entries: Vec<ManagedSkillEntry>,
}

impl Default for SkillManifest {
    fn default() -> Self {
        Self {
            version: SKILL_MANIFEST_VERSION,
            entries: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum SkillSource {
    Folder {
        path: String,
    },
    Curated {
        #[serde(rename = "packageId")]
        package_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedSkillEntry {
    pub id: String,
    pub declared_name: String,
    pub folder: String,
    pub source: SkillSource,
    pub content_sha256: String,
    pub target: SkillTarget,
    pub destination: String,
    pub installed_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestError {
    Io {
        operation: &'static str,
        path: PathBuf,
        message: String,
    },
    InvalidData(String),
    UnsupportedVersion(u64),
}

impl fmt::Display for ManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io {
                operation,
                path,
                message,
            } => write!(
                formatter,
                "Failed to {operation} {}: {message}",
                path.display()
            ),
            Self::InvalidData(message) => write!(formatter, "Invalid skill manifest: {message}"),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "Unsupported skill manifest version: {version}")
            }
        }
    }
}

impl std::error::Error for ManifestError {}

pub fn manifest_path(config_dir: &Path) -> PathBuf {
    config_dir.join(MANIFEST_DIRECTORY).join(MANIFEST_FILENAME)
}

pub fn stable_entry_id(target: &SkillTarget, folder: &str) -> Result<String, ManifestError> {
    validate_skill_slug(folder).map_err(|error| ManifestError::InvalidData(error.to_string()))?;
    let runtime = match target.runtime {
        RuntimeKind::Claude => "claude",
        RuntimeKind::Codex => "codex",
    };
    let scope = match target.scope {
        SkillScope::User => "user",
        SkillScope::Project => "project",
    };
    Ok(format!("{runtime}:{scope}:{folder}"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObservedFingerprint {
    Missing,
    Unreadable,
    Sha256(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagedCopyState {
    Unmanaged,
    Missing,
    Unchanged,
    Modified,
    PathMismatch,
    UnsafeLink,
    Unreadable,
}

pub fn merge_manifest_with_disk(
    entries: &[ManagedSkillEntry],
    mut disk_skills: Vec<RuntimeSkill>,
) -> Vec<RuntimeSkill> {
    for skill in &mut disk_skills {
        skill.managed = false;
        let source = Path::new(&skill.source_path);
        let Ok(metadata) = std::fs::symlink_metadata(source) else {
            continue;
        };
        if metadata_is_unsafe_link(&metadata) {
            continue;
        }
        let Ok(canonical_source) = source.canonicalize() else {
            continue;
        };
        let canonical_source = comparable_path(&canonical_source);

        skill.managed = skill.targets.iter().any(|target| {
            let Ok(id) = stable_entry_id(target, &skill.folder) else {
                return false;
            };
            entries.iter().any(|entry| {
                entry.id == id
                    && entry.target == *target
                    && entry.folder == skill.folder
                    && comparable_destination(&entry.destination) == canonical_source
            })
        });
    }
    disk_skills
}

pub fn assess_managed_copy(
    manifest: &SkillManifest,
    entry_id: &str,
    observed_destination: &Path,
    fingerprint: ObservedFingerprint,
) -> ManagedCopyState {
    let Some(entry) = manifest.entries.iter().find(|entry| entry.id == entry_id) else {
        return ManagedCopyState::Unmanaged;
    };
    if comparable_destination(&entry.destination) != comparable_path(observed_destination) {
        return ManagedCopyState::PathMismatch;
    }

    let metadata = match std::fs::symlink_metadata(observed_destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return ManagedCopyState::Missing;
        }
        Err(_) => return ManagedCopyState::Unreadable,
    };
    if metadata_is_unsafe_link(&metadata) {
        return ManagedCopyState::UnsafeLink;
    }
    let canonical = match observed_destination.canonicalize() {
        Ok(canonical) => canonical,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return ManagedCopyState::Missing;
        }
        Err(_) => return ManagedCopyState::Unreadable,
    };
    if comparable_destination(&entry.destination) != comparable_path(&canonical) {
        return ManagedCopyState::PathMismatch;
    }

    match fingerprint {
        ObservedFingerprint::Missing => ManagedCopyState::Missing,
        ObservedFingerprint::Unreadable => ManagedCopyState::Unreadable,
        ObservedFingerprint::Sha256(observed) => {
            if observed.len() != 64 || !observed.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                ManagedCopyState::Unreadable
            } else if observed.eq_ignore_ascii_case(&entry.content_sha256) {
                ManagedCopyState::Unchanged
            } else {
                ManagedCopyState::Modified
            }
        }
    }
}

pub fn deletion_allowed(state: ManagedCopyState, confirm_modified: bool) -> bool {
    state == ManagedCopyState::Unchanged
        || (state == ManagedCopyState::Modified && confirm_modified)
}

#[derive(Debug, Clone)]
pub struct ManifestStore {
    path: PathBuf,
    lock_path: PathBuf,
}

impl ManifestStore {
    pub fn new(config_dir: impl AsRef<Path>) -> Self {
        let path = manifest_path(config_dir.as_ref());
        let lock_path = path.with_file_name(format!("{MANIFEST_FILENAME}.lock"));
        Self { path, lock_path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<SkillManifest, ManifestError> {
        match self.read_current()? {
            ReadState::Missing => Ok(SkillManifest::default()),
            ReadState::Loaded(manifest) => Ok(manifest),
            ReadState::Corrupt => {
                let _lock = self.acquire_lock()?;
                self.load_or_recover_locked()
            }
        }
    }

    fn update<T>(
        &self,
        operation: impl FnOnce(&mut SkillManifest) -> Result<T, ManifestError>,
    ) -> Result<T, ManifestError> {
        let _lock = self.acquire_lock()?;
        let mut manifest = self.load_or_recover_locked()?;
        let result = operation(&mut manifest)?;
        validate_manifest(&manifest)?;
        self.write_atomic(&manifest)?;
        Ok(result)
    }

    pub fn upsert(&self, mut entry: ManagedSkillEntry) -> Result<(), ManifestError> {
        entry.id = stable_entry_id(&entry.target, &entry.folder)?;
        validate_entry(&entry)?;
        self.update(move |manifest| {
            if let Some(position) = manifest
                .entries
                .iter()
                .position(|existing| existing.id == entry.id)
            {
                entry.installed_at = manifest.entries[position].installed_at.clone();
                manifest.entries[position] = entry;
            } else {
                manifest.entries.push(entry);
            }
            manifest
                .entries
                .sort_by(|left, right| left.id.cmp(&right.id));
            Ok(())
        })
    }

    pub fn remove(&self, entry_id: &str) -> Result<(), ManifestError> {
        let id = entry_id.to_string();
        self.update(move |manifest| {
            let before = manifest.entries.len();
            manifest.entries.retain(|entry| entry.id != id);
            if manifest.entries.len() == before {
                return Err(ManifestError::InvalidData(format!(
                    "managed skill entry {id:?} was not found"
                )));
            }
            Ok(())
        })
    }

    fn load_or_recover_locked(&self) -> Result<SkillManifest, ManifestError> {
        match self.read_current()? {
            ReadState::Missing => Ok(SkillManifest::default()),
            ReadState::Loaded(manifest) => Ok(manifest),
            ReadState::Corrupt => self.recover_corrupt_locked(),
        }
    }

    fn read_current(&self) -> Result<ReadState, ManifestError> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(ReadState::Missing),
            Err(error) => return Err(io_error("read", &self.path, error)),
        };

        let value: serde_json::Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => return Ok(ReadState::Corrupt),
        };
        let Some(version) = value.get("version").and_then(serde_json::Value::as_u64) else {
            return Ok(ReadState::Corrupt);
        };
        if version != u64::from(SKILL_MANIFEST_VERSION) {
            return Err(ManifestError::UnsupportedVersion(version));
        }

        let manifest: SkillManifest = match serde_json::from_value(value) {
            Ok(manifest) => manifest,
            Err(_) => return Ok(ReadState::Corrupt),
        };
        if validate_manifest(&manifest).is_err() {
            return Ok(ReadState::Corrupt);
        }
        Ok(ReadState::Loaded(manifest))
    }

    fn recover_corrupt_locked(&self) -> Result<SkillManifest, ManifestError> {
        let backup = corrupt_backup_path(&self.path);
        std::fs::rename(&self.path, &backup)
            .map_err(|error| io_error("back up corrupt", &self.path, error))?;
        let empty = SkillManifest::default();
        self.write_atomic(&empty)?;
        Ok(empty)
    }

    fn acquire_lock(&self) -> Result<ManifestLock, ManifestError> {
        let parent = self.path.parent().ok_or_else(|| {
            ManifestError::InvalidData("manifest path has no parent directory".into())
        })?;
        std::fs::create_dir_all(parent)
            .map_err(|error| io_error("create manifest directory", parent, error))?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&self.lock_path)
            .map_err(|error| io_error("open manifest lock", &self.lock_path, error))?;
        FileExt::lock_exclusive(&file)
            .map_err(|error| io_error("lock manifest", &self.lock_path, error))?;
        Ok(ManifestLock(file))
    }

    fn write_atomic(&self, manifest: &SkillManifest) -> Result<(), ManifestError> {
        let parent = self.path.parent().ok_or_else(|| {
            ManifestError::InvalidData("manifest path has no parent directory".into())
        })?;
        std::fs::create_dir_all(parent)
            .map_err(|error| io_error("create manifest directory", parent, error))?;

        let temp_path = parent.join(format!(
            ".{MANIFEST_FILENAME}.{}.tmp",
            Uuid::new_v4().simple()
        ));
        let result = (|| {
            let mut bytes = serde_json::to_vec_pretty(manifest)
                .map_err(|error| ManifestError::InvalidData(error.to_string()))?;
            bytes.push(b'\n');
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp_path)
                .map_err(|error| io_error("create manifest temporary file", &temp_path, error))?;
            file.write_all(&bytes)
                .map_err(|error| io_error("write manifest temporary file", &temp_path, error))?;
            file.flush()
                .map_err(|error| io_error("flush manifest temporary file", &temp_path, error))?;
            file.sync_all()
                .map_err(|error| io_error("sync manifest temporary file", &temp_path, error))?;
            drop(file);
            atomic_replace(&temp_path, &self.path)
                .map_err(|error| io_error("replace manifest", &self.path, error))?;
            sync_parent(parent)
                .map_err(|error| io_error("sync manifest directory", parent, error))?;
            Ok(())
        })();

        if result.is_err() {
            let _ = std::fs::remove_file(&temp_path);
        }
        result
    }
}

#[derive(Debug)]
enum ReadState {
    Missing,
    Loaded(SkillManifest),
    Corrupt,
}

struct ManifestLock(File);

impl Drop for ManifestLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

fn validate_manifest(manifest: &SkillManifest) -> Result<(), ManifestError> {
    if manifest.version != SKILL_MANIFEST_VERSION {
        return Err(ManifestError::UnsupportedVersion(u64::from(
            manifest.version,
        )));
    }

    let mut ids = HashSet::new();
    let mut targets = HashSet::new();
    let mut destinations = HashSet::new();
    for entry in &manifest.entries {
        validate_entry(entry)?;
        if !ids.insert(entry.id.clone()) {
            return Err(ManifestError::InvalidData(format!(
                "duplicate entry ID {:?}",
                entry.id
            )));
        }
        if !targets.insert((entry.target.clone(), entry.folder.clone())) {
            return Err(ManifestError::InvalidData(format!(
                "duplicate target for skill {:?}",
                entry.folder
            )));
        }
        let destination_key = comparable_destination(&entry.destination);
        if !destinations.insert(destination_key) {
            return Err(ManifestError::InvalidData(format!(
                "duplicate destination {:?}",
                entry.destination
            )));
        }
    }
    Ok(())
}

fn validate_entry(entry: &ManagedSkillEntry) -> Result<(), ManifestError> {
    let expected_id = stable_entry_id(&entry.target, &entry.folder)?;
    if entry.id != expected_id {
        return Err(ManifestError::InvalidData(format!(
            "entry ID {:?} does not match {:?}",
            entry.id, expected_id
        )));
    }
    if entry.declared_name.trim().is_empty() {
        return Err(ManifestError::InvalidData(
            "declared skill name must not be empty".into(),
        ));
    }
    match &entry.source {
        SkillSource::Folder { path } if path.trim().is_empty() => {
            return Err(ManifestError::InvalidData(
                "folder source path must not be empty".into(),
            ));
        }
        SkillSource::Curated { package_id } if package_id.trim().is_empty() => {
            return Err(ManifestError::InvalidData(
                "curated package ID must not be empty".into(),
            ));
        }
        SkillSource::Folder { .. } | SkillSource::Curated { .. } => {}
    }
    if entry.content_sha256.len() != 64
        || !entry
            .content_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(ManifestError::InvalidData(
            "contentSha256 must contain 64 hexadecimal characters".into(),
        ));
    }
    if entry.installed_at.trim().is_empty() || entry.updated_at.trim().is_empty() {
        return Err(ManifestError::InvalidData(
            "installedAt and updatedAt must not be empty".into(),
        ));
    }

    let destination = Path::new(&entry.destination);
    if !destination.is_absolute() {
        return Err(ManifestError::InvalidData(
            "managed destination must be absolute".into(),
        ));
    }
    if !path_component_matches(destination.file_name(), &entry.folder) {
        return Err(ManifestError::InvalidData(
            "managed destination basename must match the skill folder".into(),
        ));
    }
    let runtime_directory = match entry.target.runtime {
        RuntimeKind::Claude => ".claude",
        RuntimeKind::Codex => ".agents",
    };
    let skills_directory = destination.parent().and_then(Path::file_name);
    let runtime_parent = destination
        .parent()
        .and_then(Path::parent)
        .and_then(Path::file_name);
    if !path_component_matches(skills_directory, "skills")
        || !path_component_matches(runtime_parent, runtime_directory)
    {
        return Err(ManifestError::InvalidData(format!(
            "managed destination must be inside {runtime_directory}/skills"
        )));
    }
    Ok(())
}

fn path_component_matches(component: Option<&std::ffi::OsStr>, expected: &str) -> bool {
    let Some(component) = component.and_then(std::ffi::OsStr::to_str) else {
        return false;
    };
    #[cfg(windows)]
    {
        component.eq_ignore_ascii_case(expected)
    }
    #[cfg(not(windows))]
    {
        component == expected
    }
}

fn comparable_destination(destination: &str) -> String {
    #[cfg(windows)]
    {
        destination.replace('/', "\\").to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        destination.to_owned()
    }
}

fn comparable_path(path: &Path) -> String {
    comparable_destination(&path.to_string_lossy())
}

fn metadata_is_unsafe_link(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn corrupt_backup_path(path: &Path) -> PathBuf {
    let timestamp = Utc::now().format("%Y%m%dT%H%M%S%.6fZ");
    path.with_file_name(format!(
        "{MANIFEST_FILENAME}.corrupt-{timestamp}-{}.bak",
        Uuid::new_v4().simple()
    ))
}

fn io_error(operation: &'static str, path: &Path, error: io::Error) -> ManifestError {
    ManifestError::Io {
        operation,
        path: path.to_path_buf(),
        message: error.to_string(),
    }
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    fn wide(path: &Path) -> io::Result<Vec<u16>> {
        let mut value = path.as_os_str().encode_wide().collect::<Vec<_>>();
        if value.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "path contains an interior NUL",
            ));
        }
        value.push(0);
        Ok(value)
    }

    let source = wide(source)?;
    let destination = wide(destination)?;
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent(_parent: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::domain::RuntimeSkill;
    use std::sync::{Arc, Barrier};

    fn hash(character: char) -> String {
        std::iter::repeat_n(character, 64).collect()
    }

    fn entry(root: &Path, folder: &str, target: SkillTarget) -> ManagedSkillEntry {
        let runtime_dir = match target.runtime {
            RuntimeKind::Claude => ".claude",
            RuntimeKind::Codex => ".agents",
        };
        let destination = root
            .join(runtime_dir)
            .join("skills")
            .join(folder)
            .to_string_lossy()
            .to_string();
        ManagedSkillEntry {
            id: stable_entry_id(&target, folder).unwrap(),
            declared_name: format!("Skill {folder}"),
            folder: folder.into(),
            source: SkillSource::Curated {
                package_id: format!("package-{folder}"),
            },
            content_sha256: hash('a'),
            target,
            destination,
            installed_at: "2026-07-17T00:00:00Z".into(),
            updated_at: "2026-07-17T00:00:00Z".into(),
        }
    }

    fn target(runtime: RuntimeKind, scope: SkillScope) -> SkillTarget {
        SkillTarget { runtime, scope }
    }

    fn write_unchecked(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn backups(store: &ManifestStore) -> Vec<PathBuf> {
        std::fs::read_dir(store.path().parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with("skills-manifest.json.corrupt-") && name.ends_with(".bak")
                    })
            })
            .collect()
    }

    fn replace_manifest(store: &ManifestStore, manifest: &SkillManifest) {
        let replacement = manifest.clone();
        store
            .update(move |current| {
                *current = replacement;
                Ok(())
            })
            .unwrap();
    }

    fn disk_skill(path: &Path, folder: &str, target: SkillTarget) -> RuntimeSkill {
        RuntimeSkill {
            id: stable_entry_id(&target, folder).unwrap(),
            name: format!("Skill {folder}"),
            description: "Test skill".into(),
            folder: folder.into(),
            source_path: path.to_string_lossy().to_string(),
            targets: vec![target],
            managed: true,
            compatible_runtimes: vec![RuntimeKind::Claude, RuntimeKind::Codex],
            enabled: false,
            discovery_error: None,
        }
    }

    #[test]
    fn missing_manifest_returns_empty_v1_without_creating_files() {
        let temp = tempfile::tempdir().unwrap();
        let store = ManifestStore::new(temp.path());

        assert_eq!(store.load().unwrap(), SkillManifest::default());
        assert_eq!(store.path(), manifest_path(temp.path()).as_path());
        assert!(!store.path().exists());
        assert!(!temp.path().join(MANIFEST_DIRECTORY).exists());
    }

    #[test]
    fn v1_round_trip_uses_the_exact_camel_case_wire_schema() {
        let temp = tempfile::tempdir().unwrap();
        let store = ManifestStore::new(temp.path());
        let manifest = SkillManifest {
            version: SKILL_MANIFEST_VERSION,
            entries: vec![entry(
                temp.path(),
                "writer",
                target(RuntimeKind::Codex, SkillScope::User),
            )],
        };

        replace_manifest(&store, &manifest);
        assert_eq!(store.load().unwrap(), manifest);
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(store.path()).unwrap()).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["entries"][0]["declaredName"], "Skill writer");
        assert_eq!(value["entries"][0]["contentSha256"], hash('a'));
        assert_eq!(value["entries"][0]["source"]["type"], "curated");
        assert_eq!(value["entries"][0]["source"]["packageId"], "package-writer");
        assert!(value["entries"][0]["source"].get("package_id").is_none());
    }

    #[test]
    fn a_second_locked_update_atomically_replaces_the_existing_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let store = ManifestStore::new(temp.path());
        replace_manifest(&store, &SkillManifest::default());
        let replacement = SkillManifest {
            version: SKILL_MANIFEST_VERSION,
            entries: vec![entry(
                temp.path(),
                "replacement",
                target(RuntimeKind::Claude, SkillScope::User),
            )],
        };

        replace_manifest(&store, &replacement);
        assert_eq!(store.load().unwrap(), replacement);
    }

    #[test]
    fn upsert_replaces_one_stable_target_and_preserves_installed_at() {
        let temp = tempfile::tempdir().unwrap();
        let store = ManifestStore::new(temp.path());
        let mut original = entry(
            temp.path(),
            "writer",
            target(RuntimeKind::Claude, SkillScope::Project),
        );
        original.installed_at = "installed-originally".into();
        store.upsert(original).unwrap();

        let mut updated = entry(
            temp.path(),
            "writer",
            target(RuntimeKind::Claude, SkillScope::Project),
        );
        updated.id = "untrusted-id".into();
        updated.content_sha256 = hash('b');
        updated.installed_at = "must-not-replace".into();
        updated.updated_at = "updated-later".into();
        store.upsert(updated).unwrap();

        let loaded = store.load().unwrap();
        assert_eq!(loaded.entries.len(), 1);
        assert_eq!(loaded.entries[0].id, "claude:project:writer");
        assert_eq!(loaded.entries[0].content_sha256, hash('b'));
        assert_eq!(loaded.entries[0].installed_at, "installed-originally");
        assert_eq!(loaded.entries[0].updated_at, "updated-later");
    }

    #[test]
    fn concurrent_store_updates_do_not_lose_entries() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().to_path_buf();
        let barrier = Arc::new(Barrier::new(6));
        let handles = (0..6)
            .map(|index| {
                let config = config.clone();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let store = ManifestStore::new(&config);
                    barrier.wait();
                    store
                        .upsert(entry(
                            &config,
                            &format!("skill-{index}"),
                            target(RuntimeKind::Codex, SkillScope::User),
                        ))
                        .unwrap();
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().unwrap();
        }

        let loaded = ManifestStore::new(&config).load().unwrap();
        assert_eq!(loaded.entries.len(), 6);
    }

    #[test]
    fn stale_snapshot_cannot_erase_a_concurrent_upsert() {
        let temp = tempfile::tempdir().unwrap();
        let store = ManifestStore::new(temp.path());
        let stale = store.load().unwrap();
        store
            .upsert(entry(
                temp.path(),
                "concurrent",
                target(RuntimeKind::Claude, SkillScope::User),
            ))
            .unwrap();

        store
            .update(|current| {
                assert_eq!(current.entries.len(), 1);
                current.version = stale.version;
                Ok(())
            })
            .unwrap();

        assert_eq!(store.load().unwrap().entries.len(), 1);
    }

    #[test]
    fn corrupt_json_is_backed_up_and_never_touches_referenced_skills() {
        let temp = tempfile::tempdir().unwrap();
        let store = ManifestStore::new(temp.path());
        let skill_dir = temp.path().join("home/.claude/skills/legacy");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(skill_dir.join("SKILL.md"), "legacy").unwrap();
        let corrupt = format!(
            "{{\"version\":1,\"destination\":{:?}",
            skill_dir.to_string_lossy()
        );
        write_unchecked(store.path(), corrupt.as_bytes());

        assert_eq!(store.load().unwrap(), SkillManifest::default());
        assert_eq!(
            std::fs::read_to_string(skill_dir.join("SKILL.md")).unwrap(),
            "legacy"
        );
        let backup_paths = backups(&store);
        assert_eq!(backup_paths.len(), 1);
        assert_eq!(std::fs::read(&backup_paths[0]).unwrap(), corrupt.as_bytes());
        assert_eq!(store.load().unwrap(), SkillManifest::default());
    }

    #[test]
    fn rapid_corrupt_recoveries_use_unique_backup_names() {
        let temp = tempfile::tempdir().unwrap();
        let store = ManifestStore::new(temp.path());
        write_unchecked(store.path(), b"{");
        store.load().unwrap();
        write_unchecked(store.path(), b"[");
        store.load().unwrap();

        let backup_paths = backups(&store);
        assert_eq!(backup_paths.len(), 2);
        assert_ne!(backup_paths[0], backup_paths[1]);
    }

    #[test]
    fn unsupported_future_version_is_left_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let store = ManifestStore::new(temp.path());
        let future = br#"{"version":2,"entries":[],"futureField":true}"#;
        write_unchecked(store.path(), future);

        assert_eq!(store.load(), Err(ManifestError::UnsupportedVersion(2)));
        assert_eq!(std::fs::read(store.path()).unwrap(), future);
        assert!(backups(&store).is_empty());
    }

    #[test]
    fn locked_update_refuses_to_overwrite_an_unsupported_future_version() {
        let temp = tempfile::tempdir().unwrap();
        let store = ManifestStore::new(temp.path());
        let future = br#"{"version":2,"entries":[],"futureField":true}"#;
        write_unchecked(store.path(), future);

        assert_eq!(
            store.update(|_| Ok(())),
            Err(ManifestError::UnsupportedVersion(2))
        );
        assert_eq!(std::fs::read(store.path()).unwrap(), future);
        assert!(backups(&store).is_empty());
    }

    #[test]
    fn semantic_id_corruption_is_backed_up_instead_of_adopted() {
        let temp = tempfile::tempdir().unwrap();
        let store = ManifestStore::new(temp.path());
        let mut invalid = entry(
            temp.path(),
            "legacy",
            target(RuntimeKind::Claude, SkillScope::User),
        );
        invalid.id = "claude:user:some-other-folder".into();
        let bytes = serde_json::to_vec(&SkillManifest {
            version: SKILL_MANIFEST_VERSION,
            entries: vec![invalid],
        })
        .unwrap();
        write_unchecked(store.path(), &bytes);

        assert_eq!(store.load().unwrap(), SkillManifest::default());
        assert_eq!(backups(&store).len(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn windows_manifest_paths_accept_filesystem_case_variations() {
        let temp = tempfile::tempdir().unwrap();
        let store = ManifestStore::new(temp.path());
        let mut managed = entry(
            temp.path(),
            "writer",
            target(RuntimeKind::Claude, SkillScope::User),
        );
        managed.destination = temp
            .path()
            .join("home/.CLAUDE/SKILLS/WRITER")
            .to_string_lossy()
            .to_string();

        replace_manifest(
            &store,
            &SkillManifest {
                version: SKILL_MANIFEST_VERSION,
                entries: vec![managed],
            },
        );
        assert_eq!(store.load().unwrap().entries.len(), 1);
    }

    #[test]
    fn duplicate_targets_and_destinations_are_semantic_corruption() {
        let temp = tempfile::tempdir().unwrap();
        for duplicate_kind in ["target", "destination"] {
            let config = temp.path().join(duplicate_kind);
            let store = ManifestStore::new(&config);
            let first = entry(
                temp.path(),
                "duplicate",
                target(RuntimeKind::Codex, SkillScope::User),
            );
            let mut second = first.clone();
            if duplicate_kind == "destination" {
                second.target.scope = SkillScope::Project;
                second.id = stable_entry_id(&second.target, &second.folder).unwrap();
            }
            let bytes = serde_json::to_vec(&SkillManifest {
                version: SKILL_MANIFEST_VERSION,
                entries: vec![first, second],
            })
            .unwrap();
            write_unchecked(store.path(), &bytes);

            assert_eq!(store.load().unwrap(), SkillManifest::default());
            assert_eq!(backups(&store).len(), 1);
        }
    }

    #[test]
    fn legacy_directory_is_visible_but_unmanaged() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("home/.claude/skills/legacy");
        std::fs::create_dir_all(&destination).unwrap();
        let disk = disk_skill(
            &destination,
            "legacy",
            target(RuntimeKind::Claude, SkillScope::User),
        );

        let catalog = merge_manifest_with_disk(&[], vec![disk]);
        assert_eq!(catalog.len(), 1);
        assert!(!catalog[0].managed);
    }

    #[test]
    fn only_an_exact_recorded_target_and_destination_is_managed() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("home/.agents/skills/writer");
        let other_destination = temp.path().join("other/.agents/skills/writer");
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::create_dir_all(&other_destination).unwrap();
        let canonical = destination.canonicalize().unwrap();
        let selected_target = target(RuntimeKind::Codex, SkillScope::User);
        let mut owned = entry(temp.path(), "writer", selected_target.clone());
        owned.destination = canonical.to_string_lossy().to_string();

        let matching = merge_manifest_with_disk(
            &[owned.clone()],
            vec![disk_skill(&destination, "writer", selected_target.clone())],
        );
        assert!(matching[0].managed);

        let wrong_path = merge_manifest_with_disk(
            &[owned.clone()],
            vec![disk_skill(&other_destination, "writer", selected_target)],
        );
        assert!(!wrong_path[0].managed);

        let wrong_target = merge_manifest_with_disk(
            &[owned],
            vec![disk_skill(
                &destination,
                "writer",
                target(RuntimeKind::Codex, SkillScope::Project),
            )],
        );
        assert!(!wrong_target[0].managed);
    }

    #[test]
    fn managed_copy_assessment_requires_id_path_metadata_and_fingerprint() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("home/.claude/skills/writer");
        let other_destination = temp.path().join("other/.claude/skills/writer");
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::create_dir_all(&other_destination).unwrap();
        let canonical = destination.canonicalize().unwrap();
        let target = target(RuntimeKind::Claude, SkillScope::User);
        let mut owned = entry(temp.path(), "writer", target);
        owned.destination = canonical.to_string_lossy().to_string();
        let manifest = SkillManifest {
            version: SKILL_MANIFEST_VERSION,
            entries: vec![owned.clone()],
        };

        assert_eq!(
            assess_managed_copy(
                &manifest,
                "claude:user:unknown",
                &canonical,
                ObservedFingerprint::Sha256(hash('a')),
            ),
            ManagedCopyState::Unmanaged
        );
        assert_eq!(
            assess_managed_copy(
                &manifest,
                &owned.id,
                &other_destination,
                ObservedFingerprint::Sha256(hash('a')),
            ),
            ManagedCopyState::PathMismatch
        );
        assert_eq!(
            assess_managed_copy(
                &manifest,
                &owned.id,
                &canonical,
                ObservedFingerprint::Sha256(hash('a')),
            ),
            ManagedCopyState::Unchanged
        );
        assert_eq!(
            assess_managed_copy(
                &manifest,
                &owned.id,
                &canonical,
                ObservedFingerprint::Sha256(hash('b')),
            ),
            ManagedCopyState::Modified
        );
        assert_eq!(
            assess_managed_copy(
                &manifest,
                &owned.id,
                &canonical,
                ObservedFingerprint::Unreadable,
            ),
            ManagedCopyState::Unreadable
        );
    }

    #[test]
    fn missing_managed_copy_is_not_deletable() {
        let temp = tempfile::tempdir().unwrap();
        let owned = entry(
            temp.path(),
            "missing",
            target(RuntimeKind::Claude, SkillScope::User),
        );
        let destination = PathBuf::from(&owned.destination);
        let manifest = SkillManifest {
            version: SKILL_MANIFEST_VERSION,
            entries: vec![owned.clone()],
        };

        assert_eq!(
            assess_managed_copy(
                &manifest,
                &owned.id,
                &destination,
                ObservedFingerprint::Missing,
            ),
            ManagedCopyState::Missing
        );
        assert!(!deletion_allowed(ManagedCopyState::Missing, true));
    }

    #[test]
    fn confirmation_only_allows_a_modified_owned_copy() {
        assert!(deletion_allowed(ManagedCopyState::Unchanged, false));
        assert!(deletion_allowed(ManagedCopyState::Unchanged, true));
        assert!(!deletion_allowed(ManagedCopyState::Modified, false));
        assert!(deletion_allowed(ManagedCopyState::Modified, true));
        for state in [
            ManagedCopyState::Unmanaged,
            ManagedCopyState::Missing,
            ManagedCopyState::PathMismatch,
            ManagedCopyState::UnsafeLink,
            ManagedCopyState::Unreadable,
        ] {
            assert!(!deletion_allowed(state, false));
            assert!(!deletion_allowed(state, true));
        }
    }

    #[test]
    fn replacing_a_recorded_directory_with_a_link_is_never_deletable() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("home/.claude/skills/writer");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let canonical = destination.canonicalize().unwrap();
        let mut owned = entry(
            temp.path(),
            "writer",
            target(RuntimeKind::Claude, SkillScope::User),
        );
        owned.destination = canonical.to_string_lossy().to_string();
        std::fs::remove_dir(&destination).unwrap();

        match create_directory_link(&outside, &destination) {
            Ok(()) => {
                let state = assess_managed_copy(
                    &SkillManifest {
                        version: SKILL_MANIFEST_VERSION,
                        entries: vec![owned.clone()],
                    },
                    &owned.id,
                    &canonical,
                    ObservedFingerprint::Sha256(hash('a')),
                );
                assert_eq!(state, ManagedCopyState::UnsafeLink);
                assert!(!deletion_allowed(state, true));
            }
            Err(error) if link_creation_is_not_permitted(&error) => {
                assert!(!deletion_allowed(ManagedCopyState::UnsafeLink, true));
            }
            Err(error) => panic!("failed to create test directory link: {error}"),
        }
    }

    #[cfg(unix)]
    fn create_directory_link(target: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_directory_link(target: &Path, link: &Path) -> io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[cfg(unix)]
    fn link_creation_is_not_permitted(error: &io::Error) -> bool {
        error.kind() == io::ErrorKind::PermissionDenied
    }

    #[cfg(windows)]
    fn link_creation_is_not_permitted(error: &io::Error) -> bool {
        matches!(error.raw_os_error(), Some(5 | 1314))
    }
}
