use crate::runtime::RuntimeKind;
use crate::skills::domain::{RuntimeSkill, SkillScope, SkillTarget};
use crate::skills::manifest::{
    assess_managed_copy, deletion_allowed, stable_entry_id, ManagedSkillEntry, ManifestStore,
    ObservedFingerprint, SkillSource,
};
use crate::skills::paths::{
    ensure_canonical_skill_containment, resolve_skill_root, skill_destination, validate_skill_slug,
};
use chrono::Utc;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSkill {
    pub name: String,
    pub description: String,
    pub folder: String,
    pub category: Option<String>,
    pub compatible_runtimes: Vec<RuntimeKind>,
    pub compatibility_note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportError {
    Message(String),
}

impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Message(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for ImportError {}

impl From<String> for ImportError {
    fn from(value: String) -> Self {
        Self::Message(value)
    }
}

impl From<&str> for ImportError {
    fn from(value: &str) -> Self {
        Self::Message(value.to_string())
    }
}

pub fn config_dir() -> Result<PathBuf, ImportError> {
    crate::providers::paths::localprism_home().map_err(ImportError::from)
}

pub fn find_skill_md(skill_dir: &Path) -> Option<PathBuf> {
    for name in ["SKILL.md", "skill.md"] {
        let candidate = skill_dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let entries = fs::read_dir(skill_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
        {
            return Some(path);
        }
    }
    None
}

pub fn collect_skill_dirs(root: &Path, output: &mut Vec<PathBuf>) {
    if find_skill_md(root).is_some() {
        output.push(root.to_path_buf());
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() || !file_type.is_dir() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            if should_skip_skill_tree_entry(name) {
                continue;
            }
        }
        collect_skill_dirs(&entry.path(), output);
    }
}

pub fn should_skip_skill_tree_entry(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git" | ".github" | ".svn" | ".hg" | "node_modules" | "__pycache__" | ".ds_store"
    )
}

fn directory_name_overrides_declared_folder(folder_name: &str) -> bool {
    !matches!(
        folder_name,
        "repo" | "raw" | "skill" | "skills" | "root" | "tmp" | "temp" | "src" | "dist"
    )
}

fn yaml_mapping_string(
    mapping: &serde_yaml::Mapping,
    key: &str,
) -> Option<String> {
    mapping
        .get(serde_yaml::Value::String(key.into()))
        .and_then(|value| match value {
            serde_yaml::Value::String(text) => Some(text.clone()),
            serde_yaml::Value::Number(number) => Some(number.to_string()),
            serde_yaml::Value::Bool(flag) => Some(flag.to_string()),
            _ => None,
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_category_label(value: &str) -> Option<String> {
    let label = value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if label.is_empty() {
        return None;
    }
    let lower = label.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "none" | "n/a" | "na" | "null" | "uncategorized" | "imported"
    ) {
        return None;
    }
    Some(label.chars().take(80).collect())
}

fn metadata_category(mapping: &serde_yaml::Mapping) -> Option<String> {
    let meta = mapping
        .get(serde_yaml::Value::String("metadata".into()))?
        .as_mapping()?;
    yaml_mapping_string(meta, "category").or_else(|| yaml_mapping_string(meta, "group"))
}

/// Category declared in SKILL.md frontmatter (`category`, `group`, or `metadata.category`).
pub fn frontmatter_skill_category(content: &str) -> Option<String> {
    let (frontmatter, _) = split_frontmatter(content);
    let raw = frontmatter?;
    let mut category = None;
    if let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(&raw) {
        if let Some(mapping) = value.as_mapping() {
            category = yaml_mapping_string(mapping, "category")
                .or_else(|| yaml_mapping_string(mapping, "group"))
                .or_else(|| metadata_category(mapping));
        }
    }
    if category.is_none() {
        category = lenient_frontmatter_field(&raw, "category")
            .or_else(|| lenient_frontmatter_field(&raw, "group"));
    }
    category.as_deref().and_then(normalize_category_label)
}

fn is_generic_skill_container(name: &str) -> bool {
    matches!(
        name,
        "skills"
            | "skill"
            | "scientific-skills"
            | "claude"
            | "claude-home"
            | "dist"
            | "src"
            | "repo"
            | "root"
            | "commands"
            | "agents"
            | "localprism"
            | "main"
            | "master"
            | "tmp"
            | "temp"
    )
}

/// Parent directory used as a category when skills live in `root/<category>/<skill>`.
pub fn category_from_parent_folder(skill_dir: &Path, root: &Path) -> Option<String> {
    let mut current = skill_dir.parent()?;
    while current.starts_with(root) && current != root {
        if let Some(name) = current.file_name().and_then(|value| value.to_str()) {
            let key = sanitize_skill_folder_name(name);
            if !key.is_empty() && !is_generic_skill_container(&key) {
                return normalize_category_label(name);
            }
        }
        current = current.parent()?;
    }
    None
}

fn skill_display_category(
    parsed: &ParsedSkill,
    skill_dir: &Path,
    root: Option<&Path>,
) -> Option<String> {
    parsed.category.clone().or_else(|| {
        root.and_then(|root| category_from_parent_folder(skill_dir, root))
    })
}

fn lenient_frontmatter_field(raw: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    for line in raw.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix(&prefix) else {
            continue;
        };
        let value = rest
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

pub fn sanitize_skill_folder_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn split_frontmatter(content: &str) -> (Option<String>, String) {
    let lines: Vec<&str> = content.lines().collect();
    if lines.first() != Some(&"---") {
        return (None, content.to_string());
    }
    let mut end = None;
    for (index, line) in lines.iter().enumerate().skip(1) {
        if *line == "---" {
            end = Some(index);
            break;
        }
    }
    let Some(end) = end else {
        return (None, content.to_string());
    };
    let frontmatter = lines[1..end].join("\n");
    let body = lines
        .get((end + 1)..)
        .map(|slice| slice.join("\n"))
        .unwrap_or_default();
    (Some(frontmatter), body)
}

pub fn validate_skill(content: &str) -> Result<ParsedSkill, ImportError> {
    let (frontmatter, body) = split_frontmatter(content);
    let mut name = None;
    let mut description = None;
    if let Some(raw) = frontmatter {
        if let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(&raw) {
            if let Some(mapping) = value.as_mapping() {
                name = yaml_mapping_string(mapping, "name");
                description = yaml_mapping_string(mapping, "description");
            }
        }
        if name.is_none() {
            name = lenient_frontmatter_field(&raw, "name");
        }
        if description.is_none() {
            description = lenient_frontmatter_field(&raw, "description");
        }
    }

    let heading_name = body
        .lines()
        .find(|line| line.starts_with("# "))
        .map(|line| line.trim_start_matches("# ").trim().to_string())
        .filter(|value| !value.is_empty());

    let resolved_name = name
        .clone()
        .or(heading_name)
        .ok_or_else(|| ImportError::from("Skill must declare a non-empty name"))?;

    let mut compatibility_note = None;
    let compatible_runtimes = if name.is_some() && description.is_some() {
        vec![RuntimeKind::Claude, RuntimeKind::Codex]
    } else if description.is_none() {
        compatibility_note = Some(
            "Legacy Claude skill is missing a standard description and can only target Claude."
                .into(),
        );
        vec![RuntimeKind::Claude]
    } else {
        compatibility_note = Some(
            "Legacy Claude skill is missing a standard name frontmatter field and can only target Claude."
                .into(),
        );
        vec![RuntimeKind::Claude]
    };

    let folder = sanitize_skill_folder_name(&resolved_name);
    if folder.is_empty() {
        return Err(ImportError::from(
            "Skill folder name is empty after sanitization",
        ));
    }
    validate_skill_slug(&folder).map_err(|error| ImportError::from(error.to_string()))?;

    Ok(ParsedSkill {
        name: resolved_name,
        description: description.unwrap_or_default(),
        folder,
        category: frontmatter_skill_category(content),
        compatible_runtimes,
        compatibility_note,
    })
}

pub fn validate_skill_dir(skill_dir: &Path) -> Result<(ParsedSkill, PathBuf), ImportError> {
    let skill_md = find_skill_md(skill_dir)
        .ok_or_else(|| ImportError::from("Selected folder does not contain SKILL.md"))?;
    let content = fs::read_to_string(&skill_md)
        .map_err(|error| ImportError::from(format!("Failed to read SKILL.md: {error}")))?;
    let mut parsed = validate_skill(&content)?;
    if let Some(folder_name) = skill_dir
        .file_name()
        .and_then(|name| name.to_str())
        .map(sanitize_skill_folder_name)
    {
        if directory_name_overrides_declared_folder(&folder_name)
            && !folder_name.is_empty()
            && validate_skill_slug(&folder_name).is_ok()
        {
            parsed.folder = folder_name;
        }
    }
    Ok((parsed, skill_md))
}

pub fn fingerprint_skill_dir(skill_dir: &Path) -> Result<String, ImportError> {
    let mut files = BTreeMap::new();
    collect_relative_files(skill_dir, skill_dir, &mut files)?;
    let mut hasher = Sha256::new();
    for (relative, bytes) in files {
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(&(bytes.len() as u64).to_le_bytes());
        hasher.update(&bytes);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn collect_relative_files(
    root: &Path,
    current: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> Result<(), ImportError> {
    let entries = fs::read_dir(current).map_err(|error| {
        ImportError::from(format!("Failed to read {}: {error}", current.display()))
    })?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
            if should_skip_skill_tree_entry(name) {
                continue;
            }
        }
        if file_type.is_dir() {
            collect_relative_files(root, &path, files)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| ImportError::from("Failed to compute relative skill path"))?
            .to_string_lossy()
            .replace('\\', "/");
        let bytes = fs::read(&path).map_err(|error| {
            ImportError::from(format!("Failed to read {}: {error}", path.display()))
        })?;
        files.insert(relative, bytes);
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), ImportError> {
    fs::create_dir_all(dst).map_err(|error| {
        ImportError::from(format!("Failed to create {}: {error}", dst.display()))
    })?;
    let entries = fs::read_dir(src)
        .map_err(|error| ImportError::from(format!("Failed to read {}: {error}", src.display())))?;
    for entry in entries.flatten() {
        let entry_path = entry.path();
        let target = dst.join(entry.file_name());
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            if should_skip_skill_tree_entry(name) {
                continue;
            }
        }
        if file_type.is_dir() {
            copy_dir_recursive(&entry_path, &target)?;
        } else if file_type.is_file() {
            fs::copy(&entry_path, &target).map_err(|error| {
                ImportError::from(format!("Failed to copy {}: {error}", entry_path.display()))
            })?;
        }
    }
    Ok(())
}

fn atomic_replace_dir(staged: &Path, destination: &Path) -> Result<Option<PathBuf>, ImportError> {
    let parent = destination
        .parent()
        .ok_or_else(|| ImportError::from("Skill destination is missing a parent directory"))?;
    fs::create_dir_all(parent).map_err(|error| {
        ImportError::from(format!("Failed to create {}: {error}", parent.display()))
    })?;

    let backup = if destination.exists() {
        let stamp = Utc::now().format("%Y%m%dT%H%M%SZ");
        let backup_path = parent.join(format!(
            ".{}.bak-{}",
            destination
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("skill"),
            stamp
        ));
        fs::rename(destination, &backup_path).map_err(|error| {
            ImportError::from(format!(
                "Failed to back up {}: {error}",
                destination.display()
            ))
        })?;
        Some(backup_path)
    } else {
        None
    };

    fs::rename(staged, destination).map_err(|error| {
        if let Some(backup_path) = &backup {
            let _ = fs::rename(backup_path, destination);
        }
        ImportError::from(format!(
            "Failed to install skill at {}: {error}",
            destination.display()
        ))
    })?;
    Ok(backup)
}

fn restore_backup(backup: Option<&Path>, destination: &Path) {
    let Some(backup) = backup else {
        let _ = fs::remove_dir_all(destination);
        return;
    };
    let _ = fs::remove_dir_all(destination);
    let _ = fs::rename(backup, destination);
}

struct StagedInstall {
    target: SkillTarget,
    destination: PathBuf,
    folder: String,
    declared_name: String,
    content_sha256: String,
    category: Option<String>,
    backup: Option<PathBuf>,
}

pub fn snapshot_installed_targets(
    skill_dir: &Path,
    targets: &[SkillTarget],
    project_path: Option<&Path>,
) -> Vec<RuntimeSkill> {
    let Ok((parsed, _)) = validate_skill_dir(skill_dir) else {
        return Vec::new();
    };
    let mut snapshots = Vec::new();
    for target in targets {
        let Ok(root) = resolve_skill_root(target.runtime, target.scope, project_path) else {
            continue;
        };
        let Ok(destination) = skill_destination(&root, &parsed.folder) else {
            continue;
        };
        if find_skill_md(&destination).is_none() {
            continue;
        }
        let folder = destination
            .file_name()
            .and_then(|name| name.to_str())
            .map(sanitize_skill_folder_name)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| parsed.folder.clone());
        let Ok(id) = stable_entry_id(target, &folder) else {
            continue;
        };
        snapshots.push(RuntimeSkill {
            id,
            name: parsed.name.clone(),
            description: parsed.description.clone(),
            folder,
            source_path: destination.to_string_lossy().to_string(),
            source_url: None,
            targets: vec![target.clone()],
            managed: true,
            compatible_runtimes: parsed.compatible_runtimes.clone(),
            enabled: target.runtime == RuntimeKind::Claude,
            discovery_error: None,
            category: skill_display_category(&parsed, &destination, Some(&root)),
        });
    }
    snapshots
}

pub fn import_skill_to_targets(
    source_path: &Path,
    targets: &[SkillTarget],
    project_path: Option<&Path>,
    source: SkillSource,
) -> Result<Vec<RuntimeSkill>, ImportError> {
    if targets.is_empty() {
        return Err(ImportError::from("At least one skill target is required"));
    }
    if !source_path.is_dir() {
        return Err(ImportError::from("Selected path is not a folder"));
    }

    let (parsed, _) = validate_skill_dir(source_path)?;
    for target in targets {
        if !parsed.compatible_runtimes.contains(&target.runtime) {
            let note = parsed
                .compatibility_note
                .clone()
                .unwrap_or_else(|| "Skill is not compatible with the requested runtime".into());
            return Err(ImportError::from(note));
        }
    }

    let content_sha256 = fingerprint_skill_dir(source_path)?;
    let mut staged = Vec::new();
    let mut installed = Vec::new();

    let install_result = (|| {
        for target in targets {
            let root = resolve_skill_root(target.runtime, target.scope, project_path)
                .map_err(|error| ImportError::from(error.to_string()))?;
            let destination = skill_destination(&root, &parsed.folder)
                .map_err(|error| ImportError::from(error.to_string()))?;
            fs::create_dir_all(&root).map_err(|error| {
                ImportError::from(format!("Failed to create {}: {error}", root.display()))
            })?;

            let staging = root.join(format!(
                ".{}.staging-{}",
                parsed.folder,
                Uuid::new_v4().simple()
            ));
            if staging.exists() {
                fs::remove_dir_all(&staging).map_err(|error| {
                    ImportError::from(format!("Failed to clear staging dir: {error}"))
                })?;
            }
            copy_dir_recursive(source_path, &staging)?;
            ensure_canonical_skill_containment(&root, &staging)
                .map_err(|error| ImportError::from(error.to_string()))?;
            let staged_hash = fingerprint_skill_dir(&staging)?;
            if staged_hash != content_sha256 {
                let _ = fs::remove_dir_all(&staging);
                return Err(ImportError::from(
                    "Staged skill fingerprint did not match the source skill",
                ));
            }

            let backup = atomic_replace_dir(&staging, &destination)?;
            staged.push(StagedInstall {
                target: target.clone(),
                destination: destination.clone(),
                folder: parsed.folder.clone(),
                declared_name: parsed.name.clone(),
                content_sha256: content_sha256.clone(),
                category: skill_display_category(&parsed, &destination, Some(&root)),
                backup,
            });
        }

        let store = ManifestStore::new(config_dir()?);
        let now = Utc::now().to_rfc3339();
        for item in &staged {
            store
                .upsert(ManagedSkillEntry {
                    id: stable_entry_id(&item.target, &item.folder)
                        .map_err(|error| ImportError::from(error.to_string()))?,
                    declared_name: item.declared_name.clone(),
                    folder: item.folder.clone(),
                    source: source.clone(),
                    content_sha256: item.content_sha256.clone(),
                    target: item.target.clone(),
                    destination: item.destination.to_string_lossy().to_string(),
                    installed_at: now.clone(),
                    updated_at: now.clone(),
                })
                .map_err(|error| ImportError::from(error.to_string()))?;

            installed.push(RuntimeSkill {
                id: stable_entry_id(&item.target, &item.folder)
                    .map_err(|error| ImportError::from(error.to_string()))?,
                name: item.declared_name.clone(),
                description: parsed.description.clone(),
                folder: item.folder.clone(),
                source_path: item.destination.to_string_lossy().to_string(),
                source_url: crate::skills::manifest::source_url_from_skill_source(&source),
                targets: vec![item.target.clone()],
                managed: true,
                compatible_runtimes: parsed.compatible_runtimes.clone(),
                enabled: item.target.runtime == RuntimeKind::Claude,
                discovery_error: None,
                category: item.category.clone(),
            });
        }
        Ok(())
    })();

    if let Err(error) = install_result {
        for item in staged.iter().rev() {
            restore_backup(item.backup.as_deref(), &item.destination);
            if let Some(backup) = &item.backup {
                let _ = fs::remove_dir_all(backup);
            }
        }
        return Err(error);
    }

    for item in staged {
        if let Some(backup) = item.backup {
            let _ = fs::remove_dir_all(backup);
        }
    }

    Ok(installed)
}

pub fn list_runtime_skills(project_path: Option<&Path>) -> Result<Vec<RuntimeSkill>, ImportError> {
    let store = ManifestStore::new(config_dir()?);
    let manifest = store
        .load()
        .map_err(|error| ImportError::from(error.to_string()))?;

    let mut disk = Vec::new();
    let mut targets = vec![SkillTarget {
        runtime: RuntimeKind::Claude,
        scope: SkillScope::User,
    }];
    if project_path.is_some() {
        targets.push(SkillTarget {
            runtime: RuntimeKind::Claude,
            scope: SkillScope::Project,
        });
    }

    for target in targets {
        let Ok(root) = resolve_skill_root(target.runtime, target.scope, project_path) else {
            continue;
        };
        if !root.exists() {
            continue;
        }
        let mut skill_dirs = Vec::new();
        collect_skill_dirs(&root, &mut skill_dirs);
        skill_dirs.sort();
        for skill_dir in skill_dirs {
            let Ok((parsed, _)) = validate_skill_dir(&skill_dir) else {
                continue;
            };
            let folder = skill_dir
                .file_name()
                .and_then(|name| name.to_str())
                .map(sanitize_skill_folder_name)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| parsed.folder.clone());
            let id = stable_entry_id(&target, &folder)
                .map_err(|error| ImportError::from(error.to_string()))?;
            let category = skill_display_category(&parsed, &skill_dir, Some(&root));
            disk.push(RuntimeSkill {
                id,
                name: parsed.name,
                description: parsed.description,
                folder,
                source_path: skill_dir.to_string_lossy().to_string(),
                source_url: None,
                targets: vec![target.clone()],
                managed: false,
                compatible_runtimes: parsed.compatible_runtimes,
                enabled: target.runtime == RuntimeKind::Claude,
                discovery_error: parsed.compatibility_note,
                category,
            });
        }
    }

    Ok(crate::skills::manifest::merge_manifest_with_disk(
        &manifest.entries,
        disk,
    ))
}

pub fn delete_managed_skill(entry_id: &str, confirm_modified: bool) -> Result<(), ImportError> {
    let store = ManifestStore::new(config_dir()?);
    let manifest = store
        .load()
        .map_err(|error| ImportError::from(error.to_string()))?;
    let entry = manifest
        .entries
        .iter()
        .find(|entry| entry.id == entry_id)
        .cloned()
        .ok_or_else(|| ImportError::from(format!("Managed skill '{entry_id}' was not found")))?;

    let destination = PathBuf::from(&entry.destination);
    let fingerprint = if destination.exists() {
        match fingerprint_skill_dir(&destination) {
            Ok(hash) => ObservedFingerprint::Sha256(hash),
            Err(_) => ObservedFingerprint::Unreadable,
        }
    } else {
        ObservedFingerprint::Missing
    };
    let state = assess_managed_copy(&manifest, entry_id, &destination, fingerprint);
    if !deletion_allowed(state, confirm_modified) {
        return Err(ImportError::from(format!(
            "Refusing to delete managed skill '{entry_id}' in state {state:?}"
        )));
    }

    if destination.exists() {
        fs::remove_dir_all(&destination).map_err(|error| {
            ImportError::from(format!(
                "Failed to delete {}: {error}",
                destination.display()
            ))
        })?;
    }
    store
        .remove(entry_id)
        .map_err(|error| ImportError::from(error.to_string()))?;
    Ok(())
}

/// Register project skill folders that already contain SKILL.md but are not yet managed.
pub fn auto_import_project_skills(project_path: &Path) -> Result<Vec<RuntimeSkill>, ImportError> {
    if !project_path.is_absolute() {
        return Err(ImportError::from(
            "Project-scoped auto-import requires an absolute project path",
        ));
    }

    let store = ManifestStore::new(config_dir()?);
    let manifest = store
        .load()
        .map_err(|error| ImportError::from(error.to_string()))?;
    let mut imported = Vec::new();

    let targets = [SkillTarget {
        runtime: RuntimeKind::Claude,
        scope: SkillScope::Project,
    }];

    for target in targets {
        let Ok(root) = resolve_skill_root(target.runtime, target.scope, Some(project_path)) else {
            continue;
        };
        if !root.exists() {
            continue;
        }
        let mut skill_dirs = Vec::new();
        collect_skill_dirs(&root, &mut skill_dirs);
        for skill_dir in skill_dirs {
            let Ok((parsed, _)) = validate_skill_dir(&skill_dir) else {
                continue;
            };
            let folder = skill_dir
                .file_name()
                .and_then(|name| name.to_str())
                .map(sanitize_skill_folder_name)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| parsed.folder.clone());
            let Ok(id) = stable_entry_id(&target, &folder) else {
                continue;
            };
            if manifest.entries.iter().any(|entry| entry.id == id) {
                continue;
            }
            if !parsed.compatible_runtimes.contains(&target.runtime) {
                continue;
            }
            let Ok(hash) = fingerprint_skill_dir(&skill_dir) else {
                continue;
            };
            let canonical = skill_dir
                .canonicalize()
                .unwrap_or_else(|_| skill_dir.clone());
            let now = Utc::now().to_rfc3339();
            let entry = ManagedSkillEntry {
                id: id.clone(),
                declared_name: parsed.name.clone(),
                folder: folder.clone(),
                source: SkillSource::Folder {
                    path: canonical.to_string_lossy().to_string(),
                },
                content_sha256: hash,
                target: target.clone(),
                destination: canonical.to_string_lossy().to_string(),
                installed_at: now.clone(),
                updated_at: now,
            };
            if store.upsert(entry).is_err() {
                continue;
            }
            let category = skill_display_category(&parsed, &skill_dir, Some(&root));
            imported.push(RuntimeSkill {
                id,
                name: parsed.name,
                description: parsed.description,
                folder,
                source_path: canonical.to_string_lossy().to_string(),
                source_url: None,
                targets: vec![target.clone()],
                managed: true,
                compatible_runtimes: parsed.compatible_runtimes,
                enabled: target.runtime == RuntimeKind::Claude,
                discovery_error: None,
                category,
            });
        }
    }

    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn write_skill(dir: &Path, name: &str, description: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n# {name}\n\nBody\n"),
        )
        .unwrap();
    }

    #[test]
    fn cross_runtime_import_requires_standard_metadata() {
        let parsed =
            validate_skill("---\nname: writer\ndescription: Writes prose\n---\n# Writer").unwrap();
        assert_eq!(
            parsed.compatible_runtimes,
            vec![RuntimeKind::Claude, RuntimeKind::Codex]
        );
    }

    #[test]
    fn legacy_claude_skill_is_claude_only() {
        let parsed = validate_skill("# Writer\n\nWrites prose\n").unwrap();
        assert_eq!(parsed.compatible_runtimes, vec![RuntimeKind::Claude]);
        assert!(parsed.compatibility_note.is_some());
    }

    #[test]
    fn import_installs_to_requested_targets_and_registers_manifest() {
        let _provider_guard = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let config = temp.path().join("config");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&config).unwrap();
        let source = temp.path().join("source/writer");
        write_skill(&source, "writer", "Writes prose");

        let previous_home = std::env::var_os("HOME");
        let previous_userprofile = std::env::var_os("USERPROFILE");
        let previous_localprism = std::env::var_os("LOCALPRISM_HOME");
        let previous_config =
            std::env::var_os("LOCALAPPDATA").or_else(|| std::env::var_os("XDG_CONFIG_HOME"));
        // dirs::home_dir / config_dir use platform env; set both common roots.
        std::env::set_var("HOME", &home);
        std::env::set_var("USERPROFILE", &home);
        std::env::set_var("LOCALPRISM_HOME", &home);
        #[cfg(windows)]
        std::env::set_var("LOCALAPPDATA", &config);
        #[cfg(not(windows))]
        std::env::set_var("XDG_CONFIG_HOME", &config);

        let result = import_skill_to_targets(
            &source,
            &[SkillTarget {
                runtime: RuntimeKind::Claude,
                scope: SkillScope::User,
            }],
            None,
            SkillSource::Folder {
                path: source.to_string_lossy().to_string(),
            },
        );
        let again = import_skill_to_targets(
            &source,
            &[SkillTarget {
                runtime: RuntimeKind::Claude,
                scope: SkillScope::User,
            }],
            None,
            SkillSource::Folder {
                path: source.to_string_lossy().to_string(),
            },
        );

        if let Some(value) = previous_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(value) = previous_userprofile {
            std::env::set_var("USERPROFILE", value);
        } else {
            std::env::remove_var("USERPROFILE");
        }
        if let Some(value) = previous_localprism {
            std::env::set_var("LOCALPRISM_HOME", value);
        } else {
            std::env::remove_var("LOCALPRISM_HOME");
        }
        #[cfg(windows)]
        {
            if let Some(value) = previous_config {
                std::env::set_var("LOCALAPPDATA", value);
            } else {
                std::env::remove_var("LOCALAPPDATA");
            }
        }
        #[cfg(not(windows))]
        {
            if let Some(value) = previous_config {
                std::env::set_var("XDG_CONFIG_HOME", value);
            } else {
                std::env::remove_var("XDG_CONFIG_HOME");
            }
        }

        let installed = result.unwrap();
        assert_eq!(installed.len(), 1);
        assert!(installed[0].managed);
        assert!(PathBuf::from(&installed[0].source_path)
            .join("SKILL.md")
            .exists());
        let replaced = again.unwrap();
        assert_eq!(replaced.len(), 1);
        assert_eq!(replaced[0].folder, "writer");
        assert!(PathBuf::from(&replaced[0].source_path)
            .join("SKILL.md")
            .exists());
    }

    #[test]
    fn archive_root_named_repo_keeps_declared_skill_folder() {
        let temp = tempfile::tempdir().unwrap();
        let skill_dir = temp.path().join("repo");
        write_skill(
            &skill_dir,
            "paper-humanizer",
            "Use when the user says: polish academic text",
        );
        fs::create_dir_all(skill_dir.join(".git")).unwrap();
        fs::write(skill_dir.join(".git/config"), "junk").unwrap();
        let (parsed, _) = validate_skill_dir(&skill_dir).unwrap();
        assert_eq!(parsed.folder, "paper-humanizer");
        assert!(parsed.description.contains("polish"));

        let named = temp.path().join("paper-humanizer-skill");
        write_skill(&named, "paper-humanizer", "Academic humanizer");
        let (named_parsed, _) = validate_skill_dir(&named).unwrap();
        assert_eq!(named_parsed.folder, "paper-humanizer-skill");
    }

    #[test]
    fn colon_description_survives_invalid_yaml() {
        let parsed = validate_skill(
            "---\nname: paper-humanizer\ndescription: Use when the user says: polish\n---\n# Paper\n",
        )
        .unwrap();
        assert_eq!(parsed.name, "paper-humanizer");
        assert!(parsed.description.contains("polish"));
        assert!(parsed.description.contains("says"));
        assert!(parsed.category.is_none());
    }

    #[test]
    fn frontmatter_category_group_and_metadata_are_kept() {
        let from_category = validate_skill(
            "---\nname: writer\ndescription: Writes prose\ncategory: Academic Writing\n---\n# Writer\n",
        )
        .unwrap();
        assert_eq!(from_category.category.as_deref(), Some("Academic Writing"));

        let from_group = validate_skill(
            "---\nname: writer\ndescription: Writes prose\ngroup: Editing\n---\n# Writer\n",
        )
        .unwrap();
        assert_eq!(from_group.category.as_deref(), Some("Editing"));

        let from_metadata = validate_skill(
            "---\nname: writer\ndescription: Writes prose\nmetadata:\n  category: Methods\n---\n# Writer\n",
        )
        .unwrap();
        assert_eq!(from_metadata.category.as_deref(), Some("Methods"));

        let blank = validate_skill(
            "---\nname: writer\ndescription: Writes prose\ncategory: uncategorized\n---\n# Writer\n",
        )
        .unwrap();
        assert!(blank.category.is_none());
    }

    #[test]
    fn nested_parent_folder_is_a_category_and_skill_roots_are_not() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let nested = root.join("writing").join("my-skill");
        let flat = root.join("scanpy");
        assert_eq!(
            category_from_parent_folder(&nested, &root).as_deref(),
            Some("writing")
        );
        assert!(category_from_parent_folder(&flat, &root).is_none());
        let packed = root.join("scientific-skills").join("scanpy");
        assert!(category_from_parent_folder(&packed, &root).is_none());
    }

    #[test]
    fn fingerprint_ignores_vcs_and_junk_dirs() {
        let temp = tempfile::tempdir().unwrap();
        let left = temp.path().join("left");
        let right = temp.path().join("right");
        write_skill(&left, "writer", "Writes prose");
        write_skill(&right, "writer", "Writes prose");
        fs::create_dir_all(left.join(".git")).unwrap();
        fs::write(left.join(".git/config"), "left").unwrap();
        fs::create_dir_all(right.join("node_modules")).unwrap();
        fs::write(right.join("node_modules/pkg.js"), "right").unwrap();
        assert_eq!(
            fingerprint_skill_dir(&left).unwrap(),
            fingerprint_skill_dir(&right).unwrap()
        );
    }
}
