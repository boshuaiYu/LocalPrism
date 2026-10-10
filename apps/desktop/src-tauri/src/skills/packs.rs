use crate::skills::domain::{SkillImportOutcome, SkillScope, SkillTarget};
use crate::skills::import::{self, config_dir};
use crate::skills::manifest::{
    assess_managed_copy, atomic_replace, deletion_allowed, metadata_is_unsafe_link,
    normalize_skill_path, skill_paths_equal, stable_entry_id, ManagedSkillEntry, ManifestStore,
    ObservedFingerprint, SkillManifest, SkillSource,
};
use crate::skills::paths::{self, validate_skill_slug};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const PREFS_FILENAME: &str = "skills-pack-preferences.json";
const PREFS_VERSION: u32 = 1;
pub(crate) const RETIRED_SCIENTIFIC_PACK: &str = "scientific-agent-skills";

const DEFAULT_PACK_REPOS: &[(&str, &str, &str)] = &[
    ("wubing2023", "paperspine", "paper-spine"),
    (
        "imbad0202",
        "academic-research-skills",
        "academic-research-skills",
    ),
    ("yuan1z0825", "nature-skills", "nature-skills"),
    ("crabin", "paper-humanizer-skill", "paper-humanizer-skill"),
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackPreferences {
    pub version: u32,
    pub opted_out_pack_ids: Vec<String>,
    pub retired_packs_purged: Vec<String>,
}

impl Default for SkillPackPreferences {
    fn default() -> Self {
        Self {
            version: PREFS_VERSION,
            opted_out_pack_ids: Vec::new(),
            retired_packs_purged: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackUpdateReport {
    pub id: String,
    pub name: String,
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub removed: Vec<String>,
    pub unchanged: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Skills found in the refreshed tree that were not part of the selection.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub available: Vec<String>,
    /// Selected skills that were not imported from this download.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing: Vec<String>,
    /// Selected skills whose folder may have been renamed. The installed copy stays.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub renamed: Vec<String>,
}

impl SkillPackUpdateReport {
    fn named(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            added: Vec::new(),
            updated: Vec::new(),
            removed: Vec::new(),
            unchanged: Vec::new(),
            error: None,
            error_code: None,
            detail: None,
            available: Vec::new(),
            missing: Vec::new(),
            renamed: Vec::new(),
        }
    }
}

#[derive(Clone, Debug)]
struct GithubRepo {
    owner: String,
    repo: String,
}

pub(crate) fn preferences_path(config: &Path) -> PathBuf {
    config.join(PREFS_FILENAME)
}

pub(crate) fn load_preferences(config: &Path) -> Result<SkillPackPreferences, String> {
    let path = preferences_path(config);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SkillPackPreferences::default());
        }
        Err(error) => {
            return Err(format!("Failed to read {}: {error}", path.display()));
        }
    };
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Failed to read skill pack preferences: {error}"))
}

pub(crate) fn load_home_preferences() -> Result<SkillPackPreferences, String> {
    load_preferences(&config_dir().map_err(|error| error.to_string())?)
}

fn save_preferences(config: &Path, prefs: &SkillPackPreferences) -> Result<(), String> {
    std::fs::create_dir_all(config)
        .map_err(|error| format!("Failed to create {}: {error}", config.display()))?;
    let path = preferences_path(config);
    let tmp = config.join(format!("{PREFS_FILENAME}.tmp"));
    let bytes = serde_json::to_vec_pretty(prefs)
        .map_err(|error| format!("Failed to write skill pack preferences: {error}"))?;
    std::fs::write(&tmp, bytes)
        .map_err(|error| format!("Failed to write {}: {error}", tmp.display()))?;
    atomic_replace(&tmp, &path)
        .map_err(|error| format!("Failed to save {}: {error}", path.display()))?;
    Ok(())
}

fn update_preferences(
    config: &Path,
    update: impl FnOnce(&mut SkillPackPreferences),
) -> Result<SkillPackPreferences, String> {
    let mut prefs = load_preferences(config)?;
    update(&mut prefs);
    prefs.version = PREFS_VERSION;
    prefs.opted_out_pack_ids.sort();
    prefs.opted_out_pack_ids.dedup();
    prefs.retired_packs_purged.sort();
    prefs.retired_packs_purged.dedup();
    save_preferences(config, &prefs)?;
    Ok(prefs)
}

pub(crate) fn is_opted_out(prefs: &SkillPackPreferences, pack_id: &str) -> bool {
    prefs.opted_out_pack_ids.iter().any(|id| id == pack_id)
}

pub(crate) fn opt_out_pack(pack_id: &str) -> Result<(), String> {
    let config = config_dir().map_err(|error| error.to_string())?;
    if !is_default_pack_id(pack_id) {
        return Ok(());
    }
    update_preferences(&config, |prefs| {
        if !prefs.opted_out_pack_ids.iter().any(|id| id == pack_id) {
            prefs.opted_out_pack_ids.push(pack_id.to_string());
        }
    })?;
    Ok(())
}

pub(crate) fn clear_opt_out(pack_id: &str) -> Result<(), String> {
    let config = config_dir().map_err(|error| error.to_string())?;
    update_preferences(&config, |prefs| {
        prefs.opted_out_pack_ids.retain(|id| id != pack_id);
    })?;
    Ok(())
}

pub(crate) fn opt_out_all_default_packs() -> Result<(), String> {
    let config = config_dir().map_err(|error| error.to_string())?;
    update_preferences(&config, |prefs| {
        for id in default_pack_ids() {
            if !prefs
                .opted_out_pack_ids
                .iter()
                .any(|existing| existing == id)
            {
                prefs.opted_out_pack_ids.push((*id).to_string());
            }
        }
        if !prefs
            .retired_packs_purged
            .iter()
            .any(|id| id == RETIRED_SCIENTIFIC_PACK)
        {
            prefs
                .retired_packs_purged
                .push(RETIRED_SCIENTIFIC_PACK.to_string());
        }
    })?;
    Ok(())
}

pub(crate) fn default_pack_ids() -> &'static [&'static str] {
    &[
        "paper-spine",
        "academic-research-skills",
        "nature-skills",
        "paper-humanizer-skill",
    ]
}

fn is_default_pack_id(pack_id: &str) -> bool {
    default_pack_ids().contains(&pack_id)
}

fn parse_github_repo(url: &str) -> Option<GithubRepo> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    let rest = if let Some(index) = lower.find("github.com/") {
        &trimmed[index + "github.com/".len()..]
    } else if let Some(index) = lower.find("raw.githubusercontent.com/") {
        &trimmed[index + "raw.githubusercontent.com/".len()..]
    } else if let Some(index) = lower.find("codeload.github.com/") {
        &trimmed[index + "codeload.github.com/".len()..]
    } else {
        return None;
    };
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let mut parts = rest.split('/').filter(|part| !part.is_empty());
    let owner = parts.next()?.trim().to_ascii_lowercase();
    let repo = parts
        .next()?
        .trim()
        .trim_end_matches(".git")
        .to_ascii_lowercase();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(GithubRepo { owner, repo })
}

pub(crate) fn is_scientific_repo_url(url: &str) -> bool {
    const OWNER: &str = "k-dense-ai";
    const REPOS: &[&str] = &["scientific-agent-skills", "claude-scientific-skills"];
    parse_github_repo(url)
        .is_some_and(|repo| repo.owner == OWNER && REPOS.contains(&repo.repo.as_str()))
}

pub(crate) fn is_retired_scientific_source(source: &SkillSource) -> bool {
    match source {
        SkillSource::Url { url, .. } => is_scientific_repo_url(url),
        SkillSource::Curated { package_id } => {
            let id = package_id.trim().to_ascii_lowercase();
            id == "scientific-agent-skills" || id == "claude-scientific-skills"
        }
        SkillSource::Folder { .. } => false,
    }
}

pub(crate) fn default_pack_id_from_url(url: &str) -> Option<&'static str> {
    let repo = parse_github_repo(url)?;
    DEFAULT_PACK_REPOS
        .iter()
        .find_map(|(owner, name, id)| (*owner == repo.owner && *name == repo.repo).then_some(*id))
}

pub(crate) fn default_pack_id_from_source(source: &SkillSource) -> Option<&'static str> {
    match source {
        SkillSource::Url { url, .. } => default_pack_id_from_url(url),
        SkillSource::Curated { package_id } => default_pack_ids()
            .iter()
            .copied()
            .find(|id| *id == package_id),
        SkillSource::Folder { .. } => None,
    }
}

fn entry_belongs_to_default_pack(entry: &ManagedSkillEntry, pack_id: &str) -> bool {
    default_pack_id_from_source(&entry.source) == Some(pack_id)
}

pub(crate) fn urls_same_pack(left: &str, right: &str) -> bool {
    if is_scientific_repo_url(left) && is_scientific_repo_url(right) {
        return true;
    }
    if let (Some(left_repo), Some(right_repo)) = (parse_github_repo(left), parse_github_repo(right))
    {
        return left_repo.owner == right_repo.owner && left_repo.repo == right_repo.repo;
    }
    normalize_url(left) == normalize_url(right)
}

fn normalize_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_ascii_lowercase()
}

pub(crate) fn sources_same_pack(left: &SkillSource, right: &SkillSource) -> bool {
    match (left, right) {
        (SkillSource::Url { url: left, .. }, SkillSource::Url { url: right, .. }) => {
            urls_same_pack(left, right)
        }
        (SkillSource::Folder { path: left }, SkillSource::Folder { path: right }) => {
            folder_paths_same(left, right)
        }
        (SkillSource::Curated { package_id: left }, SkillSource::Curated { package_id: right }) => {
            left.eq_ignore_ascii_case(right)
        }
        _ => false,
    }
}

fn folder_paths_same(left: &str, right: &str) -> bool {
    let left_path = Path::new(left);
    let right_path = Path::new(right);
    if let (Ok(left_canon), Ok(right_canon)) = (left_path.canonicalize(), right_path.canonicalize())
    {
        return left_canon == right_canon;
    }
    folder_keys_equal(left, right)
}

fn normalize_folder_key(path: &str) -> String {
    normalize_skill_path(path)
}

/// Compare recorded folder paths. `case_insensitive` is the Windows rule so
/// Linux tests can exercise `C:\Pack` versus `c:\pack` without a Windows host.
pub(crate) fn folder_keys_equal_with(left: &str, right: &str, case_insensitive: bool) -> bool {
    skill_paths_equal(left, right, case_insensitive)
}

fn folder_keys_equal(left: &str, right: &str) -> bool {
    folder_keys_equal_with(left, right, cfg!(windows))
}

fn is_portable_absolute(normalized: &str) -> bool {
    if normalized.starts_with('/') {
        return true;
    }
    let bytes = normalized.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
}

/// Lexical check for an installed skill directory. `Component::Prefix` is not
/// a rejection: Windows destinations always have one. `..` is rejected here,
/// the same way archive-relative extraction rejects parent segments.
pub(crate) fn lexical_skill_destination_error(
    destination: &str,
    root: &str,
    folder: &str,
    case_insensitive: bool,
) -> Option<&'static str> {
    if folder.is_empty()
        || folder.contains('/')
        || folder.contains('\\')
        || folder == "."
        || folder == ".."
    {
        return Some("folder");
    }
    let destination = normalize_folder_key(destination);
    let root = normalize_folder_key(root);
    if destination.split('/').any(|part| part == "..") || root.split('/').any(|part| part == "..") {
        return Some("parent");
    }
    if !is_portable_absolute(&destination) || !is_portable_absolute(&root) {
        return Some("relative");
    }
    let expected = format!("{root}/{folder}");
    let matches = if case_insensitive {
        destination.eq_ignore_ascii_case(&expected)
    } else {
        destination == expected
    };
    if matches {
        None
    } else {
        Some("outside")
    }
}

pub(crate) fn purge_retired_default_packs() -> Result<SkillPackUpdateReport, String> {
    let config = config_dir().map_err(|error| error.to_string())?;
    let prefs = load_preferences(&config)?;
    let mut report = SkillPackUpdateReport::named(RETIRED_SCIENTIFIC_PACK, RETIRED_SCIENTIFIC_PACK);
    if prefs
        .retired_packs_purged
        .iter()
        .any(|id| id == RETIRED_SCIENTIFIC_PACK)
    {
        return Ok(report);
    }
    report.removed = remove_entries(&config, is_retired_scientific_source)?;
    update_preferences(&config, |prefs| {
        if !prefs
            .retired_packs_purged
            .iter()
            .any(|id| id == RETIRED_SCIENTIFIC_PACK)
        {
            prefs
                .retired_packs_purged
                .push(RETIRED_SCIENTIFIC_PACK.to_string());
        }
    })?;
    Ok(report)
}

pub(crate) fn remove_default_pack(
    pack_id: &str,
    opt_out: bool,
) -> Result<SkillPackUpdateReport, String> {
    let config = config_dir().map_err(|error| error.to_string())?;
    if !is_default_pack_id(pack_id) {
        return Err(format!("Unknown default skill pack: {pack_id}"));
    }
    let mut report = SkillPackUpdateReport::named(pack_id, pack_id);
    report.removed = remove_matching_entries(&config, |entry| {
        entry_belongs_to_default_pack(entry, pack_id)
    })?;
    if opt_out {
        opt_out_pack(pack_id)?;
    }
    Ok(report)
}

pub(crate) fn remove_pack_source(
    source_url: Option<&str>,
    source_folder: Option<&str>,
    default_pack_id: Option<&str>,
    opt_out: bool,
) -> Result<SkillPackUpdateReport, String> {
    if let Some(pack_id) = default_pack_id.map(str::trim).filter(|id| !id.is_empty()) {
        return remove_default_pack(pack_id, opt_out);
    }
    let config = config_dir().map_err(|error| error.to_string())?;
    if let Some(url) = source_url.map(str::trim).filter(|url| !url.is_empty()) {
        let mut report = SkillPackUpdateReport::named(url, url);
        report.removed = remove_matching_entries(&config, |entry| match &entry.source {
            SkillSource::Url { url: recorded, .. } => urls_same_pack(recorded, url),
            _ => false,
        })?;
        if let Some(pack_id) = default_pack_id_from_url(url) {
            if opt_out {
                opt_out_pack(pack_id)?;
            }
        }
        return Ok(report);
    }
    if let Some(folder) = source_folder.map(str::trim).filter(|path| !path.is_empty()) {
        let name = Path::new(folder)
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| folder.to_string());
        let mut report = SkillPackUpdateReport::named(folder, name);
        report.removed = remove_matching_entries(&config, |entry| match &entry.source {
            SkillSource::Folder { path } => folder_paths_same(path, folder),
            _ => false,
        })?;
        return Ok(report);
    }
    Err("Choose a skill pack to uninstall.".into())
}

pub(crate) fn remove_source_skills_except(
    source: &SkillSource,
    kept_folders: &[String],
) -> Result<Vec<String>, String> {
    let config = config_dir().map_err(|error| error.to_string())?;
    let kept: HashSet<&str> = kept_folders.iter().map(String::as_str).collect();
    remove_matching_entries(&config, |entry| {
        sources_same_pack(&entry.source, source) && !kept.contains(entry.folder.as_str())
    })
}

fn remove_entries(
    config: &Path,
    predicate: impl Fn(&SkillSource) -> bool,
) -> Result<Vec<String>, String> {
    remove_matching_entries(config, |entry| predicate(&entry.source))
}

fn remove_matching_entries(
    config: &Path,
    predicate: impl Fn(&ManagedSkillEntry) -> bool,
) -> Result<Vec<String>, String> {
    let (store, entries) = plan_removals(config, predicate)?;
    commit_removals(&store, &entries)
}

pub(crate) fn uninstall_all_managed_skills() -> Result<Vec<String>, String> {
    let config = config_dir().map_err(|error| error.to_string())?;
    let (store, entries) = plan_removals(&config, |_| true)?;
    opt_out_all_default_packs()?;
    commit_removals(&store, &entries)
}

fn plan_removals(
    config: &Path,
    predicate: impl Fn(&ManagedSkillEntry) -> bool,
) -> Result<(ManifestStore, Vec<ManagedSkillEntry>), String> {
    let store = ManifestStore::new(config);
    let manifest = store
        .load()
        .map_err(|error| format!("Failed to read skill manifest: {error}"))?;
    let entries: Vec<ManagedSkillEntry> = manifest
        .entries
        .iter()
        .filter(|entry| predicate(entry))
        .cloned()
        .collect();
    for entry in &entries {
        ensure_entry_deletable(&manifest, entry)?;
    }
    Ok((store, entries))
}

fn commit_removals(
    store: &ManifestStore,
    entries: &[ManagedSkillEntry],
) -> Result<Vec<String>, String> {
    let mut removed = Vec::new();
    for entry in entries {
        delete_skill_files(entry)?;
        store
            .remove(&entry.id)
            .map_err(|error| format!("Failed to remove {}: {error}", entry.folder))?;
        removed.push(entry.declared_name.clone());
    }
    removed.sort();
    removed.dedup();
    Ok(removed)
}

fn skills_root_for_entry(entry: &ManagedSkillEntry) -> Result<PathBuf, String> {
    match entry.target.scope {
        SkillScope::User => paths::resolve_skill_root(entry.target.runtime, SkillScope::User, None)
            .map_err(|error| error.to_string()),
        SkillScope::Project => {
            let destination = Path::new(&entry.destination);
            let skills = destination.parent().ok_or_else(|| {
                format!(
                    "Refusing to delete skill {}: destination has no skills root",
                    entry.folder
                )
            })?;
            let localprism = skills.parent().ok_or_else(|| {
                format!(
                    "Refusing to delete skill {}: destination is outside the project skills root",
                    entry.folder
                )
            })?;
            let project = localprism.parent().ok_or_else(|| {
                format!(
                    "Refusing to delete skill {}: destination is outside the project skills root",
                    entry.folder
                )
            })?;
            if !folder_keys_equal(
                &skills.file_name().unwrap_or_default().to_string_lossy(),
                "skills",
            ) || !folder_keys_equal(
                &localprism.file_name().unwrap_or_default().to_string_lossy(),
                ".localprism",
            ) {
                return Err(format!(
                    "Refusing to delete skill {}: destination is outside the project skills root",
                    entry.folder
                ));
            }
            paths::resolve_skill_root(entry.target.runtime, SkillScope::Project, Some(project))
                .map_err(|error| error.to_string())
        }
    }
}

fn ensure_entry_deletable(
    manifest: &SkillManifest,
    entry: &ManagedSkillEntry,
) -> Result<(), String> {
    if validate_skill_slug(&entry.folder).is_err() {
        return Err(format!(
            "Refusing to delete skill {}: invalid folder name",
            entry.folder
        ));
    }
    let root = skills_root_for_entry(entry)?;
    if std::fs::symlink_metadata(&root)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(format!(
            "Refusing to delete skill {}: skills root is a symlink",
            entry.folder
        ));
    }
    if let Some(reason) = lexical_skill_destination_error(
        &entry.destination,
        &root.to_string_lossy(),
        &entry.folder,
        cfg!(windows),
    ) {
        return Err(format!(
            "Refusing to delete skill {}: destination is {reason}",
            entry.folder
        ));
    }
    let dest = PathBuf::from(&entry.destination);
    if !dest.exists() {
        return Ok(());
    }
    let metadata = std::fs::symlink_metadata(&dest)
        .map_err(|error| format!("Failed to inspect {}: {error}", dest.display()))?;
    if metadata_is_unsafe_link(&metadata) {
        return Err(format!(
            "Refusing to delete skill {}: destination is a symlink",
            entry.folder
        ));
    }
    if !metadata.is_dir() {
        return Err(format!(
            "Refusing to delete skill {}: destination is not a directory",
            entry.folder
        ));
    }
    paths::ensure_canonical_skill_containment(&root, &dest).map_err(|error| {
        format!(
            "Refusing to delete skill {}: destination is outside the skills root ({error})",
            entry.folder
        )
    })?;
    let fingerprint = match import::fingerprint_skill_dir(&dest) {
        Ok(hash) => ObservedFingerprint::Sha256(hash),
        Err(_) => ObservedFingerprint::Unreadable,
    };
    let state = assess_managed_copy(manifest, &entry.id, &dest, fingerprint);
    if !deletion_allowed(state, false) {
        return Err(format!(
            "Refusing to delete skill {}: copy is {state:?}",
            entry.folder
        ));
    }
    Ok(())
}

fn delete_skill_files(entry: &ManagedSkillEntry) -> Result<(), String> {
    let dest = PathBuf::from(&entry.destination);
    if !dest.exists() {
        return Ok(());
    }
    let metadata = std::fs::symlink_metadata(&dest)
        .map_err(|error| format!("Failed to inspect {}: {error}", dest.display()))?;
    if metadata_is_unsafe_link(&metadata) || !metadata.is_dir() {
        return Err(format!(
            "Refusing to delete skill {}: destination is not a managed directory",
            entry.folder
        ));
    }
    std::fs::remove_dir_all(&dest)
        .map_err(|error| format!("Failed to delete {}: {error}", dest.display()))?;
    Ok(())
}

pub(crate) fn update_local_pack(
    source_path: &Path,
    targets: &[SkillTarget],
    project: Option<&Path>,
) -> Result<SkillPackUpdateReport, String> {
    let name = source_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| source_path.display().to_string());
    if !source_path.exists() {
        let mut report = SkillPackUpdateReport::named(source_path.display().to_string(), name);
        report.error_code = Some("missing-folder".into());
        report.detail = Some(source_path.display().to_string());
        report.error = Some(format!(
            "The recorded folder or archive is gone: {}",
            source_path.display()
        ));
        return Ok(report);
    }
    let source = SkillSource::Folder {
        path: source_path.to_string_lossy().to_string(),
    };
    if source_path.is_dir() {
        let mut skill_dirs = Vec::new();
        import::collect_skill_dirs(source_path, &mut skill_dirs);
        skill_dirs.sort();
        return import_and_reconcile(source, skill_dirs, targets, project, name);
    }
    if super::archive::is_skill_archive(source_path) {
        let workspace = super::short_skill_temp_dir("upd");
        std::fs::create_dir_all(&workspace)
            .map_err(|error| format!("Failed to create archive workspace: {error}"))?;
        let extracted = super::archive::extract_skill_archive(
            source_path,
            &workspace,
            crate::skills::fetch::ExtractLimits::default(),
        );
        let report = match extracted {
            Ok(root) => {
                let mut skill_dirs = Vec::new();
                import::collect_skill_dirs(&root, &mut skill_dirs);
                skill_dirs.sort();
                import_and_reconcile(source, skill_dirs, targets, project, name)
            }
            Err(error) => Err(error),
        };
        let _ = std::fs::remove_dir_all(&workspace);
        return report;
    }
    Err("Recorded skill source is not a folder or archive.".into())
}

fn import_and_reconcile(
    source: SkillSource,
    skill_dirs: Vec<PathBuf>,
    targets: &[SkillTarget],
    project: Option<&Path>,
    name: String,
) -> Result<SkillPackUpdateReport, String> {
    let outcome =
        super::import_collected_skill_dirs(skill_dirs, targets, project, source.clone(), false)?;
    let kept: Vec<String> = outcome
        .skills
        .iter()
        .map(|skill| skill.folder.clone())
        .collect();
    let removed = if outcome.errors.is_empty() {
        remove_source_skills_except(&source, &kept)?
    } else {
        Vec::new()
    };
    let mut report = SkillPackUpdateReport::named(name.clone(), name);
    report.added = outcome.added;
    report.updated = outcome.updated;
    report.unchanged = outcome.unchanged;
    report.removed = removed;
    if !outcome.errors.is_empty() {
        report.error = Some(outcome.errors.join("\n"));
        report.error_code = Some("import".into());
    }
    Ok(report)
}

pub(crate) fn manifest_entries(config: &Path) -> Result<SkillManifest, String> {
    ManifestStore::new(config)
        .load()
        .map_err(|error| format!("Failed to read skill manifest: {error}"))
}

/// Name shown for a refreshed pack. Default packs use the pack-list name;
/// other GitHub repos keep the repository name's original casing.
pub(crate) fn pack_refresh_display_name(url: &str) -> String {
    if let Some(id) = default_pack_id_from_url(url) {
        return match id {
            "paper-spine" => "PaperSpine".to_string(),
            other => other.to_string(),
        };
    }
    github_repo_display_name(url).unwrap_or_else(|| url.trim().to_string())
}

fn github_repo_display_name(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    let rest = if let Some(index) = lower.find("github.com/") {
        &trimmed[index + "github.com/".len()..]
    } else if let Some(index) = lower.find("raw.githubusercontent.com/") {
        &trimmed[index + "raw.githubusercontent.com/".len()..]
    } else if let Some(index) = lower.find("codeload.github.com/") {
        &trimmed[index + "codeload.github.com/".len()..]
    } else {
        return None;
    };
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let mut parts = rest.split('/').filter(|part| !part.is_empty());
    let _owner = parts.next()?;
    let repo = parts.next()?.trim();
    let repo = repo
        .strip_suffix(".git")
        .or_else(|| repo.strip_suffix(".GIT"))
        .unwrap_or(repo);
    if repo.is_empty() {
        None
    } else {
        Some(repo.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RecordedUrlSkill {
    folder: String,
    declared_name: String,
    content_sha256: String,
    url: String,
    subpath: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UrlRefreshScope {
    pub extract_subpath: Option<String>,
    /// `None` means this source has no installed skills yet, so a refresh
    /// installs every skill under the requested tree.
    pub allow_folders: Option<Vec<String>>,
    pub migrated: bool,
    recorded: Vec<RecordedUrlSkill>,
}

pub(crate) fn load_url_refresh_scope(request_url: &str) -> Result<UrlRefreshScope, String> {
    let config = config_dir().map_err(|error| error.to_string())?;
    let manifest = manifest_entries(&config)?;
    Ok(url_refresh_scope(request_url, &manifest.entries))
}

/// Skills a URL refresh may install, plus the tree to extract.
///
/// A recorded `selected` list wins. Older entries with no selection use the
/// skill folders already installed from that source, so a later refresh cannot
/// pick up new upstream skills.
pub(crate) fn url_refresh_scope(
    request_url: &str,
    entries: &[ManagedSkillEntry],
) -> UrlRefreshScope {
    let matching: Vec<&ManagedSkillEntry> = entries
        .iter()
        .filter(|entry| match &entry.source {
            SkillSource::Url { url, .. } => urls_same_pack(url, request_url),
            _ => false,
        })
        .collect();
    if matching.is_empty() {
        return UrlRefreshScope {
            extract_subpath: super::github_import_subpath(request_url),
            allow_folders: None,
            migrated: false,
            recorded: Vec::new(),
        };
    }

    let recorded = matching
        .iter()
        .filter_map(|entry| match &entry.source {
            SkillSource::Url { url, subpath, .. } => Some(RecordedUrlSkill {
                folder: entry.folder.clone(),
                declared_name: entry.declared_name.clone(),
                content_sha256: entry.content_sha256.clone(),
                url: url.clone(),
                subpath: subpath
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .and_then(super::normalize_portable_subpath)
                    .or_else(|| super::github_import_subpath(url)),
            }),
            _ => None,
        })
        .collect::<Vec<_>>();

    let explicit = matching.iter().all(|entry| match &entry.source {
        SkillSource::Url { selected, .. } => !selected.is_empty(),
        _ => false,
    });
    let any_explicit = matching.iter().any(|entry| match &entry.source {
        SkillSource::Url { selected, .. } => !selected.is_empty(),
        _ => false,
    });
    let mut allow = Vec::new();
    if explicit {
        for entry in &matching {
            if let SkillSource::Url { selected, .. } = &entry.source {
                allow.extend(selected.iter().cloned());
            }
        }
    } else if any_explicit {
        for entry in &matching {
            match &entry.source {
                SkillSource::Url { selected, .. } if !selected.is_empty() => {
                    allow.extend(selected.iter().cloned());
                }
                _ => allow.push(entry.folder.clone()),
            }
        }
    } else {
        allow.extend(matching.iter().map(|entry| entry.folder.clone()));
    }

    let request_subpath = super::github_import_subpath(request_url);
    let extract_subpath = if request_subpath.is_some() {
        request_subpath
    } else {
        let subs: Vec<String> = recorded
            .iter()
            .filter_map(|item| item.subpath.clone())
            .collect();
        if !recorded.is_empty() && subs.len() == recorded.len() {
            common_subpath(&subs)
        } else {
            None
        }
    };

    UrlRefreshScope {
        extract_subpath,
        allow_folders: Some(dedup_names(allow)),
        migrated: !explicit,
        recorded,
    }
}

fn common_subpath(paths: &[String]) -> Option<String> {
    let mut shared: Option<Vec<String>> = None;
    for path in paths {
        let next: Vec<String> = path
            .replace('\\', "/")
            .split('/')
            .filter(|part| !part.is_empty())
            .map(str::to_string)
            .collect();
        if next.is_empty() {
            return None;
        }
        shared = Some(match shared {
            None => next,
            Some(current) => {
                let len = current.len().min(next.len());
                let mut count = 0;
                while count < len && current[count].eq_ignore_ascii_case(&next[count]) {
                    count += 1;
                }
                if count == 0 {
                    return None;
                }
                current.into_iter().take(count).collect()
            }
        });
    }
    shared
        .filter(|items| !items.is_empty())
        .map(|items| items.join("/"))
}

fn dedup_names(names: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for name in names {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.to_ascii_lowercase()) {
            unique.push(trimmed.to_string());
        }
    }
    unique
}

struct ParsedUpstream {
    dir: PathBuf,
    folder: String,
    name: String,
    fingerprint: Option<String>,
}

struct InvalidUpstream {
    folder: String,
    message: String,
}

fn inspect_upstream(skill_dirs: &[PathBuf]) -> (Vec<ParsedUpstream>, Vec<InvalidUpstream>) {
    let mut valid = Vec::new();
    let mut invalid = Vec::new();
    for dir in skill_dirs {
        let folder_name = dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string();
        match import::validate_skill_dir(dir) {
            Ok((parsed, _)) => valid.push(ParsedUpstream {
                dir: dir.clone(),
                folder: parsed.folder,
                name: parsed.name,
                fingerprint: import::fingerprint_skill_dir(dir).ok(),
            }),
            Err(error) => {
                if import::find_skill_md(dir).is_some() {
                    invalid.push(InvalidUpstream {
                        folder: if folder_name.is_empty() {
                            "skill".into()
                        } else {
                            folder_name
                        },
                        message: error.to_string(),
                    });
                }
            }
        }
    }
    (valid, invalid)
}

fn folder_key(name: &str) -> String {
    name.trim().to_ascii_lowercase()
}

fn same_folder(left: &str, right: &str) -> bool {
    folder_key(left) == folder_key(right)
}

fn selection_label(scope: &UrlRefreshScope, folder: &str) -> String {
    scope
        .recorded
        .iter()
        .find(|item| same_folder(&item.folder, folder))
        .map(|item| item.declared_name.trim())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| folder.to_string())
}

fn match_renamed<'a>(
    recorded: &RecordedUrlSkill,
    upstream: &'a [ParsedUpstream],
    claimed: &HashSet<String>,
) -> Option<&'a ParsedUpstream> {
    let candidates: Vec<&ParsedUpstream> = upstream
        .iter()
        .filter(|item| !claimed.contains(&folder_key(&item.folder)))
        .filter(|item| !same_folder(&item.folder, &recorded.folder))
        .collect();
    let by_hash: Vec<&ParsedUpstream> = candidates
        .iter()
        .copied()
        .filter(|item| {
            item.fingerprint.as_deref().is_some_and(|hash| {
                !recorded.content_sha256.is_empty()
                    && hash.eq_ignore_ascii_case(&recorded.content_sha256)
            })
        })
        .collect();
    if by_hash.len() == 1 {
        return Some(by_hash[0]);
    }
    let declared = recorded.declared_name.trim();
    let by_name: Vec<&ParsedUpstream> = candidates
        .iter()
        .copied()
        .filter(|item| !declared.is_empty() && item.name.eq_ignore_ascii_case(declared))
        .collect();
    if by_name.len() == 1 {
        Some(by_name[0])
    } else {
        None
    }
}

pub(crate) fn import_new_url_skills(
    source_url: &str,
    skill_dirs: Vec<PathBuf>,
    targets: &[SkillTarget],
    project: Option<&Path>,
    skip_existing: bool,
) -> Result<SkillImportOutcome, String> {
    let outcome = super::import_collected_skill_dirs(
        skill_dirs,
        targets,
        project,
        SkillSource::url(source_url),
        skip_existing,
    )?;
    let folders: Vec<String> = outcome
        .skills
        .iter()
        .map(|skill| skill.folder.clone())
        .collect();
    stamp_url_skills(source_url, None, &folders, &[])?;
    Ok(outcome)
}

pub(crate) fn refresh_url_pack_from_dirs(
    request_url: &str,
    skill_dirs: Vec<PathBuf>,
    targets: &[SkillTarget],
    project: Option<&Path>,
    name: &str,
    tree_complete: bool,
) -> Result<SkillPackUpdateReport, String> {
    let config = config_dir().map_err(|error| error.to_string())?;
    let manifest = manifest_entries(&config)?;
    let scope = url_refresh_scope(request_url, &manifest.entries);
    let Some(allow) = scope.allow_folders.clone() else {
        if skill_dirs.is_empty() {
            return Err(
                "Downloaded source does not contain any skills. A skill must contain SKILL.md."
                    .into(),
            );
        }
        let outcome = super::import_collected_skill_dirs(
            skill_dirs,
            targets,
            project,
            SkillSource::url(request_url),
            false,
        )?;
        let kept: Vec<String> = outcome
            .skills
            .iter()
            .map(|skill| skill.folder.clone())
            .collect();
        let removed = if outcome.errors.is_empty() {
            remove_url_skills_except(request_url, &kept, None)?
        } else {
            Vec::new()
        };
        if outcome.errors.is_empty() {
            stamp_url_skills(
                request_url,
                scope.extract_subpath.as_deref(),
                &kept,
                &scope.recorded,
            )?;
        }
        return Ok(report_from_import(
            request_url,
            name,
            outcome,
            removed,
            Vec::new(),
            Vec::new(),
            Vec::new(),
        ));
    };

    let (valid, invalid) = inspect_upstream(&skill_dirs);
    let mut claimed = HashSet::new();
    let mut install_dirs = Vec::new();
    let mut parse_errors = Vec::new();
    let mut missing = Vec::new();
    let mut renamed = Vec::new();
    let mut vanished = Vec::new();
    let mut replaced_old = Vec::new();
    let mut replacement_folders: Vec<(String, String)> = Vec::new();
    let mut replacement_names = Vec::new();
    let mut pending = Vec::new();

    for allow_name in &allow {
        if let Some(found) = valid
            .iter()
            .find(|item| same_folder(&item.folder, allow_name))
        {
            claimed.insert(folder_key(&found.folder));
            install_dirs.push(found.dir.clone());
            continue;
        }
        if let Some(bad) = invalid
            .iter()
            .find(|item| same_folder(&item.folder, allow_name))
        {
            let label = selection_label(&scope, allow_name);
            parse_errors.push(format!("{label}: {}", bad.message));
            missing.push(label);
            continue;
        }
        pending.push(allow_name.clone());
    }

    for allow_name in pending {
        let recorded = scope
            .recorded
            .iter()
            .find(|item| same_folder(&item.folder, &allow_name));
        if let Some(recorded) = recorded {
            if let Some(matched) = match_renamed(recorded, &valid, &claimed) {
                claimed.insert(folder_key(&matched.folder));
                install_dirs.push(matched.dir.clone());
                replaced_old.push(recorded.folder.clone());
                replacement_folders.push((recorded.folder.clone(), matched.folder.clone()));
                replacement_names.push(matched.name.clone());
                continue;
            }
        }
        let extras = valid.iter().any(|item| {
            !claimed.contains(&folder_key(&item.folder))
                && !allow.iter().any(|name| same_folder(&item.folder, name))
        });
        let label = selection_label(&scope, &allow_name);
        if tree_complete && !extras && parse_errors.is_empty() {
            vanished.push(allow_name);
        } else {
            missing.push(label.clone());
            if extras {
                renamed.push(label);
            }
        }
    }

    let mut available: Vec<String> = valid
        .iter()
        .filter(|item| !claimed.contains(&folder_key(&item.folder)))
        .map(|item| item.name.clone())
        .collect();
    available.sort();
    available.dedup();

    let mut outcome = if install_dirs.is_empty() {
        SkillImportOutcome::empty()
    } else {
        super::import_collected_skill_dirs(
            install_dirs,
            targets,
            project,
            SkillSource::url(request_url),
            false,
        )?
    };
    for replacement in replacement_names {
        if let Some(position) = outcome.added.iter().position(|name| name == &replacement) {
            outcome.added.remove(position);
            outcome.updated.push(replacement);
        }
    }
    let kept: Vec<String> = outcome
        .skills
        .iter()
        .map(|skill| skill.folder.clone())
        .collect();
    let mut drop_folders = Vec::new();
    if outcome.errors.is_empty() {
        // A confident rename already imported the new folder. Drop only that old
        // folder. An unresolved absence or a parse failure never joins this list,
        // so remove_url_skills_except cannot clear the selection.
        drop_folders.extend(replaced_old);
        if parse_errors.is_empty() && missing.is_empty() && renamed.is_empty() {
            drop_folders.extend(vanished);
        }
    }
    let mut removed = if drop_folders.is_empty() {
        Vec::new()
    } else {
        remove_url_skills_except(request_url, &kept, Some(&drop_folders))?
    };
    removed.retain(|name| {
        !outcome.added.iter().any(|added| added == name)
            && !outcome.updated.iter().any(|updated| updated == name)
            && !outcome.unchanged.iter().any(|unchanged| unchanged == name)
    });
    if outcome.errors.is_empty() {
        let mut recorded_for_stamp = scope.recorded.clone();
        for (old_folder, new_folder) in &replacement_folders {
            if let Some(mut copy) = recorded_for_stamp
                .iter()
                .find(|item| same_folder(&item.folder, old_folder))
                .cloned()
            {
                copy.folder = new_folder.clone();
                recorded_for_stamp.push(copy);
            }
        }
        stamp_url_skills(
            request_url,
            scope.extract_subpath.as_deref(),
            &kept,
            &recorded_for_stamp,
        )?;
    }
    let mut report = report_from_import(
        request_url,
        name,
        outcome,
        removed,
        available,
        missing,
        renamed,
    );
    if !parse_errors.is_empty() {
        report.error = Some(parse_errors.join("\n"));
        report.error_code = Some("invalid-skill".into());
    }
    Ok(report)
}

fn report_from_import(
    id: &str,
    name: &str,
    outcome: SkillImportOutcome,
    removed: Vec<String>,
    available: Vec<String>,
    missing: Vec<String>,
    renamed: Vec<String>,
) -> SkillPackUpdateReport {
    let mut report = SkillPackUpdateReport::named(id, name);
    report.added = outcome.added;
    report.updated = outcome.updated;
    report.unchanged = outcome.unchanged;
    report.removed = removed;
    report.available = available;
    report.missing = missing;
    report.renamed = renamed;
    if !outcome.errors.is_empty() {
        report.error = Some(outcome.errors.join("\n"));
        report.error_code = Some("import".into());
    }
    report
}

fn stamp_url_skills(
    request_url: &str,
    incoming_subpath: Option<&str>,
    folders: &[String],
    recorded: &[RecordedUrlSkill],
) -> Result<(), String> {
    if folders.is_empty() {
        return Ok(());
    }
    let config = config_dir().map_err(|error| error.to_string())?;
    let store = ManifestStore::new(&config);
    let wanted: HashSet<String> = folders.iter().map(|name| folder_key(name)).collect();
    store
        .revise_sources(|entry| {
            if !wanted.contains(&folder_key(&entry.folder)) {
                return None;
            }
            let SkillSource::Url { url, subpath, .. } = &entry.source else {
                return None;
            };
            if !urls_same_pack(url, request_url) {
                return None;
            }
            let preserved = recorded
                .iter()
                .find(|item| same_folder(&item.folder, &entry.folder));
            let next_url = preserved
                .map(|item| item.url.clone())
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| url.clone());
            let next_subpath = subpath
                .as_deref()
                .and_then(super::normalize_portable_subpath)
                .or_else(|| preserved.and_then(|item| item.subpath.clone()))
                .or_else(|| incoming_subpath.and_then(super::normalize_portable_subpath))
                .or_else(|| super::github_import_subpath(&next_url));
            let folder = entry.folder.clone();
            Some(SkillSource::Url {
                url: next_url,
                subpath: next_subpath.filter(|value| !value.is_empty()),
                selected: vec![folder],
            })
        })
        .map_err(|error| format!("Failed to record skill selection: {error}"))
}

fn remove_url_skills_except(
    request_url: &str,
    kept_folders: &[String],
    only_folders: Option<&[String]>,
) -> Result<Vec<String>, String> {
    let config = config_dir().map_err(|error| error.to_string())?;
    let source = SkillSource::url(request_url);
    let kept: HashSet<String> = kept_folders
        .iter()
        .map(|folder| folder.to_ascii_lowercase())
        .collect();
    let only: Option<HashSet<String>> = only_folders.map(|names| {
        names
            .iter()
            .map(|name| name.trim().to_ascii_lowercase())
            .collect()
    });
    remove_matching_entries(&config, |entry| {
        if !sources_same_pack(&entry.source, &source) {
            return false;
        }
        if kept.contains(&entry.folder.to_ascii_lowercase()) {
            return false;
        }
        match &only {
            Some(allow) => allow.contains(&entry.folder.to_ascii_lowercase()),
            None => true,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::RuntimeKind;
    use crate::skills::manifest::SkillSource;
    use std::fs;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn user_target() -> SkillTarget {
        SkillTarget {
            runtime: RuntimeKind::Claude,
            scope: SkillScope::User,
        }
    }

    fn skills_root(home: &Path) -> PathBuf {
        home.join("claude-home").join("skills")
    }

    fn entry(root: &Path, folder: &str, name: &str, source: SkillSource) -> ManagedSkillEntry {
        let destination = skills_root(root).join(folder);
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("SKILL.md"), format!("# {name}\n")).unwrap();
        let target = user_target();
        ManagedSkillEntry {
            id: stable_entry_id(&target, folder).unwrap(),
            declared_name: name.into(),
            folder: folder.into(),
            source,
            content_sha256: import::fingerprint_skill_dir(&destination).unwrap(),
            target,
            destination: destination.to_string_lossy().to_string(),
            installed_at: "2026-07-17T00:00:00Z".into(),
            updated_at: "2026-07-17T00:00:00Z".into(),
        }
    }

    fn write_manifest(config: &Path, entries: Vec<ManagedSkillEntry>) {
        let store = ManifestStore::new(config);
        for item in entries {
            store.upsert(item).unwrap();
        }
    }

    struct HomeGuard {
        previous: Option<std::ffi::OsString>,
    }

    impl HomeGuard {
        fn set(home: &Path) -> Self {
            let previous = std::env::var_os("LOCALPRISM_HOME");
            std::env::set_var("LOCALPRISM_HOME", home);
            Self { previous }
        }
    }

    impl Drop for HomeGuard {
        fn drop(&mut self) {
            if let Some(value) = self.previous.take() {
                std::env::set_var("LOCALPRISM_HOME", value);
            } else {
                std::env::remove_var("LOCALPRISM_HOME");
            }
        }
    }

    #[test]
    fn opt_out_persists_across_reloads_and_can_be_cleared() {
        let temp = tempfile::tempdir().unwrap();
        assert!(load_preferences(temp.path())
            .unwrap()
            .opted_out_pack_ids
            .is_empty());
        update_preferences(temp.path(), |prefs| {
            prefs.opted_out_pack_ids.push("paper-spine".into());
        })
        .unwrap();
        let loaded = load_preferences(temp.path()).unwrap();
        assert!(is_opted_out(&loaded, "paper-spine"));
        assert!(!is_opted_out(&loaded, "nature-skills"));
        update_preferences(temp.path(), |prefs| {
            prefs.opted_out_pack_ids.retain(|id| id != "paper-spine");
        })
        .unwrap();
        assert!(!is_opted_out(
            &load_preferences(temp.path()).unwrap(),
            "paper-spine"
        ));
        update_preferences(temp.path(), |prefs| {
            prefs.opted_out_pack_ids.push("nature-skills".into());
            prefs.opted_out_pack_ids.push("nature-skills".into());
        })
        .unwrap();
        let again = load_preferences(temp.path()).unwrap();
        assert_eq!(again.opted_out_pack_ids, vec!["nature-skills".to_string()]);
    }

    #[test]
    fn preferences_save_replaces_an_existing_file() {
        let temp = tempfile::tempdir().unwrap();
        update_preferences(temp.path(), |prefs| {
            prefs.opted_out_pack_ids.push("paper-spine".into());
        })
        .unwrap();
        update_preferences(temp.path(), |prefs| {
            prefs.opted_out_pack_ids = vec!["nature-skills".into()];
        })
        .unwrap();
        let loaded = load_preferences(temp.path()).unwrap();
        assert_eq!(loaded.opted_out_pack_ids, vec!["nature-skills".to_string()]);
        let raw = fs::read_to_string(preferences_path(temp.path())).unwrap();
        assert!(raw.contains("nature-skills"));
        assert!(!raw.contains("paper-spine"));
    }

    #[test]
    fn windows_destinations_stay_inside_the_skills_root_without_rejecting_prefixes() {
        let root = r"C:\Users\me\claude-home\skills";
        assert_eq!(
            lexical_skill_destination_error(
                r"C:\Users\me\claude-home\skills\scanpy",
                root,
                "scanpy",
                true,
            ),
            None
        );
        assert_eq!(
            lexical_skill_destination_error(
                r"\\?\C:\Users\me\claude-home\skills\scanpy",
                root,
                "scanpy",
                true,
            ),
            None
        );
        assert_eq!(
            lexical_skill_destination_error(
                r"c:\users\me\claude-home\skills\Scanpy",
                root,
                "scanpy",
                true,
            ),
            None
        );
        assert_eq!(
            lexical_skill_destination_error(r"D:\elsewhere\skills\scanpy", root, "scanpy", true,),
            Some("outside")
        );
        assert_eq!(
            lexical_skill_destination_error(
                r"C:\Users\me\claude-home\skills\..\windows\scanpy",
                root,
                "scanpy",
                true,
            ),
            Some("parent")
        );
        assert!(folder_keys_equal_with(r"C:\Pack", r"c:\pack", true));
        assert!(folder_keys_equal_with(r"\\?\C:\Pack", r"C:\pack", true));
        assert!(!folder_keys_equal_with("/Pack", "/pack", false));
    }

    #[test]
    fn retired_pack_removal_deletes_only_that_manifest_source() {
        let _provider = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let _home = HomeGuard::set(&home);
        let scientific = entry(
            &home,
            "scanpy",
            "Scanpy",
            SkillSource::url("https://github.com/K-Dense-AI/scientific-agent-skills"),
        );
        let legacy = entry(
            &home,
            "anndata",
            "AnnData",
            SkillSource::url(
                "https://github.com/K-Dense-AI/claude-scientific-skills/tree/main/skills",
            ),
        );
        let nature = entry(
            &home,
            "nature-polishing",
            "Nature polishing",
            SkillSource::url("https://github.com/Yuan1z0825/nature-skills/tree/main/skills"),
        );
        let imported = entry(
            &home,
            "my-writer",
            "My writer",
            SkillSource::Folder {
                path: temp.path().join("imports").to_string_lossy().to_string(),
            },
        );
        let scanpy_dir = PathBuf::from(&scientific.destination);
        write_manifest(&home, vec![scientific, legacy, nature, imported]);

        let removed = purge_retired_default_packs().unwrap();
        assert_eq!(
            removed.removed,
            vec!["AnnData".to_string(), "Scanpy".to_string()]
        );
        assert!(!scanpy_dir.exists());
        let folders: Vec<_> = manifest_entries(&home)
            .unwrap()
            .entries
            .into_iter()
            .map(|entry| entry.folder)
            .collect();
        assert_eq!(
            folders,
            vec!["my-writer".to_string(), "nature-polishing".to_string()]
        );

        let again = entry(
            &home,
            "scanpy",
            "Scanpy",
            SkillSource::url("https://github.com/K-Dense-AI/scientific-agent-skills"),
        );
        write_manifest(&home, vec![again]);
        let second = purge_retired_default_packs().unwrap();
        assert!(second.removed.is_empty());
        assert!(manifest_entries(&home)
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.folder == "scanpy"));
    }

    #[test]
    fn default_pack_removal_keeps_folder_imports_and_other_owners() {
        let _provider = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let _home = HomeGuard::set(&home);
        let official = entry(
            &home,
            "nature-polishing",
            "Nature polishing",
            SkillSource::url("https://github.com/Yuan1z0825/nature-skills/tree/main/skills"),
        );
        let custom = entry(
            &home,
            "nature-custom",
            "Nature custom",
            SkillSource::Folder {
                path: temp
                    .path()
                    .join("nature-custom")
                    .to_string_lossy()
                    .to_string(),
            },
        );
        let fork = entry(
            &home,
            "nature-fork",
            "Nature fork",
            SkillSource::url("https://github.com/someone-else/nature-skills"),
        );
        let custom_dir = PathBuf::from(&custom.destination);
        write_manifest(&home, vec![official, custom, fork]);

        let removed = remove_default_pack("nature-skills", true).unwrap();
        assert_eq!(removed.removed, vec!["Nature polishing".to_string()]);
        assert!(custom_dir.join("SKILL.md").is_file());
        let folders: Vec<_> = manifest_entries(&home)
            .unwrap()
            .entries
            .into_iter()
            .map(|item| item.folder)
            .collect();
        assert_eq!(
            folders,
            vec!["nature-custom".to_string(), "nature-fork".to_string()]
        );
        assert!(is_opted_out(
            &load_preferences(&home).unwrap(),
            "nature-skills"
        ));
    }

    #[test]
    fn retired_pack_url_requires_the_official_owner() {
        let _provider = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let _home = HomeGuard::set(&home);
        let fork = entry(
            &home,
            "scanpy",
            "Scanpy fork",
            SkillSource::url("https://github.com/someone-else/scientific-agent-skills"),
        );
        let fork_dir = PathBuf::from(&fork.destination);
        write_manifest(&home, vec![fork]);
        let removed = purge_retired_default_packs().unwrap();
        assert!(removed.removed.is_empty());
        assert!(fork_dir.join("SKILL.md").is_file());
        assert!(!is_scientific_repo_url(
            "https://github.com/someone-else/scientific-agent-skills"
        ));
        assert!(is_scientific_repo_url(
            "https://github.com/K-Dense-AI/claude-scientific-skills"
        ));
    }

    #[test]
    fn pack_uninstall_refuses_a_modified_copy() {
        let _provider = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let _home = HomeGuard::set(&home);
        let skill = entry(
            &home,
            "nature-polishing",
            "Nature polishing",
            SkillSource::url("https://github.com/Yuan1z0825/nature-skills"),
        );
        let dir = PathBuf::from(&skill.destination);
        write_manifest(&home, vec![skill]);
        fs::write(dir.join("SKILL.md"), "# edited\n").unwrap();
        let error = remove_default_pack("nature-skills", true).unwrap_err();
        assert!(error.contains("Modified"), "{error}");
        assert!(dir.join("SKILL.md").is_file());
        assert_eq!(manifest_entries(&home).unwrap().entries.len(), 1);
        assert!(load_preferences(&home)
            .unwrap()
            .opted_out_pack_ids
            .is_empty());
    }

    #[test]
    fn uninstall_all_removes_only_manifest_entries() {
        let _provider = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let _home = HomeGuard::set(&home);
        let managed = entry(
            &home,
            "my-writer",
            "My writer",
            SkillSource::Folder {
                path: temp.path().join("imports").to_string_lossy().to_string(),
            },
        );
        let root = skills_root(&home);
        let extra = root.join("hand-notes");
        fs::create_dir_all(&extra).unwrap();
        fs::write(extra.join("SKILL.md"), "# notes\n").unwrap();
        write_manifest(&home, vec![managed]);

        let removed = uninstall_all_managed_skills().unwrap();
        assert_eq!(removed, vec!["My writer".to_string()]);
        assert!(root.is_dir());
        assert!(extra.join("SKILL.md").is_file());
        assert!(manifest_entries(&home).unwrap().entries.is_empty());
        let prefs = load_preferences(&home).unwrap();
        assert!(is_opted_out(&prefs, "paper-spine"));
        assert!(is_opted_out(&prefs, "nature-skills"));
        assert!(prefs
            .retired_packs_purged
            .iter()
            .any(|id| id == "scientific-agent-skills"));
    }

    #[cfg(unix)]
    #[test]
    fn uninstall_all_refuses_a_symlinked_skills_root() {
        use std::os::unix::fs::symlink;

        let _provider = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let real = temp.path().join("real-skills");
        fs::create_dir_all(&real).unwrap();
        fs::create_dir_all(home.join("claude-home")).unwrap();
        symlink(&real, home.join("claude-home").join("skills")).unwrap();
        let _home = HomeGuard::set(&home);
        let skill = entry(
            &home,
            "my-writer",
            "My writer",
            SkillSource::Folder {
                path: temp.path().join("imports").to_string_lossy().to_string(),
            },
        );
        write_manifest(&home, vec![skill]);
        let error = uninstall_all_managed_skills().unwrap_err();
        assert!(error.contains("symlink"), "{error}");
        assert!(real.join("my-writer").join("SKILL.md").is_file());
        assert_eq!(manifest_entries(&home).unwrap().entries.len(), 1);
    }

    #[test]
    fn folder_pack_update_reports_added_updated_removed_and_unchanged() {
        let _provider = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let _home = HomeGuard::set(&home);
        let source = temp.path().join("pack");
        write_skill(&source.join("alpha"), "Alpha", "Original alpha");
        write_skill(&source.join("beta"), "Beta", "Keep beta");
        write_skill(&source.join("gone"), "Gone", "Remove me");

        let first = update_local_pack(&source, &[user_target()], None).unwrap();
        assert_eq!(
            first.added,
            vec!["Alpha".to_string(), "Beta".to_string(), "Gone".to_string()]
        );
        assert!(first.removed.is_empty());
        assert!(first.error.is_none());

        write_skill(&source.join("alpha"), "Alpha", "Edited alpha");
        fs::remove_dir_all(source.join("gone")).unwrap();
        write_skill(&source.join("gamma"), "Gamma", "New gamma");

        let second = update_local_pack(&source, &[user_target()], None).unwrap();
        assert_eq!(second.added, vec!["Gamma".to_string()]);
        assert_eq!(second.updated, vec!["Alpha".to_string()]);
        assert_eq!(second.unchanged, vec!["Beta".to_string()]);
        assert_eq!(second.removed, vec!["Gone".to_string()]);
        let folders: Vec<_> = manifest_entries(&home)
            .unwrap()
            .entries
            .into_iter()
            .map(|entry| entry.folder)
            .collect();
        assert_eq!(
            folders,
            vec!["alpha".to_string(), "beta".to_string(), "gamma".to_string()]
        );

        let missing = temp.path().join("missing-pack");
        let report = update_local_pack(&missing, &[user_target()], None).unwrap();
        assert_eq!(report.error_code.as_deref(), Some("missing-folder"));
        assert!(report.detail.as_deref().unwrap().contains("missing-pack"));
        assert!(report
            .error
            .as_deref()
            .unwrap()
            .contains("folder or archive"));
    }

    fn write_skill(dir: &Path, name: &str, description: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n# {name}\n"),
        )
        .unwrap();
    }

    fn collect_dirs(root: &Path) -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        import::collect_skill_dirs(root, &mut dirs);
        dirs.sort();
        dirs
    }

    fn bare_url_entry(folder: &str, url: &str) -> ManagedSkillEntry {
        let target = user_target();
        ManagedSkillEntry {
            id: stable_entry_id(&target, folder).unwrap(),
            declared_name: folder.into(),
            folder: folder.into(),
            source: SkillSource::url(url),
            content_sha256: "a".repeat(64),
            target,
            destination: format!("/tmp/skills/{folder}"),
            installed_at: "2026-07-17T00:00:00Z".into(),
            updated_at: "2026-07-17T00:00:00Z".into(),
        }
    }

    fn url_fields(entry: &ManagedSkillEntry) -> (String, Option<String>, Vec<String>) {
        match &entry.source {
            SkillSource::Url {
                url,
                subpath,
                selected,
            } => (url.clone(), subpath.clone(), selected.clone()),
            other => panic!("expected a url source, got {other:?}"),
        }
    }

    #[test]
    fn pack_refresh_display_name_matches_the_pack_list() {
        assert_eq!(
            pack_refresh_display_name(
                "https://github.com/WUBING2023/PaperSpine/tree/main/dist/claude/skills"
            ),
            "PaperSpine"
        );
        assert_eq!(
            pack_refresh_display_name("https://github.com/anthropics/skills"),
            "skills"
        );
        assert_eq!(
            pack_refresh_display_name("https://github.com/anthropics/Skills.git"),
            "Skills"
        );
    }

    #[test]
    fn refresh_scope_migrates_a_legacy_skill_subpath() {
        let entry = bare_url_entry(
            "brand-guidelines",
            "https://github.com/anthropics/skills/tree/main/skills/brand-guidelines",
        );
        let scope = url_refresh_scope("https://github.com/anthropics/skills", &[entry]);
        assert!(scope.migrated);
        assert_eq!(
            scope.extract_subpath.as_deref(),
            Some("skills/brand-guidelines")
        );
        assert_eq!(
            scope.allow_folders,
            Some(vec!["brand-guidelines".to_string()])
        );
    }

    #[test]
    fn refresh_scope_keeps_recorded_skills_under_their_common_subpath() {
        let mut brand = bare_url_entry(
            "brand-guidelines",
            "https://github.com/anthropics/skills/tree/main/skills/brand-guidelines",
        );
        brand.source = SkillSource::Url {
            url: "https://github.com/anthropics/skills/tree/main/skills/brand-guidelines".into(),
            subpath: Some("skills/brand-guidelines".into()),
            selected: vec!["brand-guidelines".into()],
        };
        let mut canvas = bare_url_entry(
            "canvas-design",
            "https://github.com/anthropics/skills/tree/main/skills/canvas-design",
        );
        canvas.source = SkillSource::Url {
            url: "https://github.com/anthropics/skills/tree/main/skills/canvas-design".into(),
            subpath: Some("skills/canvas-design".into()),
            selected: vec!["canvas-design".into()],
        };
        let scope = url_refresh_scope("https://github.com/anthropics/skills", &[brand, canvas]);
        assert!(!scope.migrated);
        assert_eq!(scope.extract_subpath.as_deref(), Some("skills"));
        assert_eq!(
            scope.allow_folders,
            Some(vec![
                "brand-guidelines".to_string(),
                "canvas-design".to_string()
            ])
        );
    }

    #[test]
    fn refresh_scope_uses_the_subpath_on_the_update_link() {
        let entry = bare_url_entry("paper-spine", "https://github.com/WUBING2023/PaperSpine");
        let scope = url_refresh_scope(
            "https://github.com/WUBING2023/PaperSpine/tree/main/dist/claude/skills",
            &[entry],
        );
        assert_eq!(scope.extract_subpath.as_deref(), Some("dist/claude/skills"));
        assert_eq!(scope.allow_folders, Some(vec!["paper-spine".to_string()]));
    }

    #[test]
    fn url_import_records_selection_and_update_skips_new_skills() {
        let _provider = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let _home = HomeGuard::set(&home);
        let repo = temp.path().join("repo");
        write_skill(
            &repo.join("skills").join("brand-guidelines"),
            "Brand guidelines",
            "Keep",
        );
        let imported = import_new_url_skills(
            "https://github.com/anthropics/skills/tree/main/skills/brand-guidelines",
            collect_dirs(&repo),
            &[user_target()],
            None,
            false,
        )
        .unwrap();
        assert_eq!(imported.added, vec!["Brand guidelines".to_string()]);
        let saved = manifest_entries(&home).unwrap().entries;
        assert_eq!(saved.len(), 1);
        let (url, subpath, selected) = url_fields(&saved[0]);
        assert!(url.contains("skills/brand-guidelines"), "{url}");
        assert_eq!(subpath.as_deref(), Some("skills/brand-guidelines"));
        assert_eq!(selected, vec!["brand-guidelines".to_string()]);

        write_skill(&repo.join("skills").join("canvas-design"), "Canvas", "New");
        write_skill(&repo.join("skills").join("docx"), "Docx", "New");
        let report = refresh_url_pack_from_dirs(
            "https://github.com/anthropics/skills",
            collect_dirs(&repo),
            &[user_target()],
            None,
            "skills",
            true,
        )
        .unwrap();
        assert!(report.added.is_empty(), "{report:?}");
        assert_eq!(report.unchanged, vec!["Brand guidelines".to_string()]);
        assert!(report.removed.is_empty(), "{report:?}");
        assert_eq!(
            report.available,
            vec!["Canvas".to_string(), "Docx".to_string()]
        );
        let saved = manifest_entries(&home).unwrap().entries;
        assert_eq!(
            saved
                .iter()
                .map(|entry| entry.folder.clone())
                .collect::<Vec<_>>(),
            vec!["brand-guidelines".to_string()]
        );
        let (url, subpath, selected) = url_fields(&saved[0]);
        assert!(url.contains("skills/brand-guidelines"), "{url}");
        assert_eq!(subpath.as_deref(), Some("skills/brand-guidelines"));
        assert_eq!(selected, vec!["brand-guidelines".to_string()]);

        write_skill(&repo.join("skills").join("slack-gif"), "Slack gif", "Newer");
        let again = refresh_url_pack_from_dirs(
            "https://github.com/anthropics/skills",
            collect_dirs(&repo),
            &[user_target()],
            None,
            "skills",
            true,
        )
        .unwrap();
        assert!(again.added.is_empty(), "{again:?}");
        assert!(again.available.iter().any(|name| name == "Slack gif"));
        assert_eq!(manifest_entries(&home).unwrap().entries.len(), 1);
    }

    #[test]
    fn legacy_url_pack_update_keeps_only_the_installed_skill() {
        let _provider = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let _home = HomeGuard::set(&home);
        let destination = skills_root(&home).join("brand-guidelines");
        write_skill(&destination, "Brand guidelines", "Keep");
        let target = user_target();
        let legacy = ManagedSkillEntry {
            id: stable_entry_id(&target, "brand-guidelines").unwrap(),
            declared_name: "Brand guidelines".into(),
            folder: "brand-guidelines".into(),
            source: SkillSource::url(
                "https://github.com/anthropics/skills/tree/main/skills/brand-guidelines",
            ),
            content_sha256: import::fingerprint_skill_dir(&destination).unwrap(),
            target,
            destination: destination.to_string_lossy().to_string(),
            installed_at: "2026-07-17T00:00:00Z".into(),
            updated_at: "2026-07-17T00:00:00Z".into(),
        };
        write_manifest(&home, vec![legacy]);

        let repo = temp.path().join("repo");
        write_skill(
            &repo.join("skills").join("brand-guidelines"),
            "Brand guidelines",
            "Keep",
        );
        write_skill(&repo.join("skills").join("canvas-design"), "Canvas", "New");
        let report = refresh_url_pack_from_dirs(
            "https://github.com/anthropics/skills",
            collect_dirs(&repo),
            &[user_target()],
            None,
            "skills",
            true,
        )
        .unwrap();
        assert!(report.added.is_empty(), "{report:?}");
        assert_eq!(report.unchanged, vec!["Brand guidelines".to_string()]);
        assert_eq!(report.available, vec!["Canvas".to_string()]);
        let saved = manifest_entries(&home).unwrap().entries;
        assert_eq!(saved.len(), 1);
        let (url, subpath, selected) = url_fields(&saved[0]);
        assert!(url.contains("brand-guidelines"), "{url}");
        assert_eq!(subpath.as_deref(), Some("skills/brand-guidelines"));
        assert_eq!(selected, vec!["brand-guidelines".to_string()]);

        let kept = refresh_url_pack_from_dirs(
            "https://github.com/anthropics/skills",
            collect_dirs(&repo.join("skills").join("canvas-design")),
            &[user_target()],
            None,
            "skills",
            false,
        )
        .unwrap();
        assert!(kept.removed.is_empty(), "{kept:?}");
        assert!(kept.added.is_empty(), "{kept:?}");
        assert_eq!(kept.missing, vec!["Brand guidelines".to_string()]);
        assert_eq!(kept.renamed, vec!["Brand guidelines".to_string()]);
        let saved = manifest_entries(&home).unwrap().entries;
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].folder, "brand-guidelines");
        let (_, _, selected) = url_fields(&saved[0]);
        assert_eq!(selected, vec!["brand-guidelines".to_string()]);
        assert!(destination.join("SKILL.md").is_file());
    }

    fn installed_url_skill(
        home: &Path,
        folder: &str,
        name: &str,
        description: &str,
        url: &str,
        subpath: Option<&str>,
        selected: &[&str],
    ) -> PathBuf {
        let destination = skills_root(home).join(folder);
        write_skill(&destination, name, description);
        let target = user_target();
        let source = if let Some(subpath) = subpath {
            SkillSource::Url {
                url: url.into(),
                subpath: Some(subpath.into()),
                selected: selected.iter().map(|name| (*name).to_string()).collect(),
            }
        } else {
            SkillSource::url(url)
        };
        let entry = ManagedSkillEntry {
            id: stable_entry_id(&target, folder).unwrap(),
            declared_name: name.into(),
            folder: folder.into(),
            source,
            content_sha256: import::fingerprint_skill_dir(&destination).unwrap(),
            target,
            destination: destination.to_string_lossy().to_string(),
            installed_at: "2026-07-17T00:00:00Z".into(),
            updated_at: "2026-07-17T00:00:00Z".into(),
        };
        write_manifest(home, vec![entry]);
        destination
    }

    #[test]
    fn invalid_selected_skill_markdown_is_not_deleted() {
        let _provider = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let _home = HomeGuard::set(&home);
        let destination = installed_url_skill(
            &home,
            "brand-guidelines",
            "Brand guidelines",
            "Keep",
            "https://github.com/anthropics/skills/tree/main/skills/brand-guidelines",
            Some("skills/brand-guidelines"),
            &["brand-guidelines"],
        );
        let broken = temp.path().join("brand-guidelines");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join("SKILL.md"), "not a skill\n").unwrap();

        let report = refresh_url_pack_from_dirs(
            "https://github.com/anthropics/skills",
            vec![broken],
            &[user_target()],
            None,
            "skills",
            true,
        )
        .unwrap();
        assert!(report.removed.is_empty(), "{report:?}");
        assert_eq!(report.error_code.as_deref(), Some("invalid-skill"));
        assert_eq!(report.missing, vec!["Brand guidelines".to_string()]);
        let saved = manifest_entries(&home).unwrap().entries;
        assert_eq!(saved.len(), 1);
        let (_, _, selected) = url_fields(&saved[0]);
        assert_eq!(selected, vec!["brand-guidelines".to_string()]);
        assert!(fs::read_to_string(destination.join("SKILL.md"))
            .unwrap()
            .contains("Brand guidelines"));
    }

    #[test]
    fn nonempty_tree_without_the_selected_folder_keeps_the_selection() {
        let _provider = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let _home = HomeGuard::set(&home);
        installed_url_skill(
            &home,
            "brand-guidelines",
            "Brand guidelines",
            "Keep",
            "https://github.com/anthropics/skills/tree/main/skills",
            Some("skills"),
            &["brand-guidelines"],
        );
        let canvas = temp.path().join("canvas-design");
        write_skill(&canvas, "Canvas", "New");

        let report = refresh_url_pack_from_dirs(
            "https://github.com/anthropics/skills",
            vec![canvas],
            &[user_target()],
            None,
            "skills",
            true,
        )
        .unwrap();
        assert!(report.removed.is_empty(), "{report:?}");
        assert!(report.added.is_empty(), "{report:?}");
        assert_eq!(report.missing, vec!["Brand guidelines".to_string()]);
        assert_eq!(report.renamed, vec!["Brand guidelines".to_string()]);
        assert_eq!(report.available, vec!["Canvas".to_string()]);
        let saved = manifest_entries(&home).unwrap().entries;
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].folder, "brand-guidelines");
        let (_, subpath, selected) = url_fields(&saved[0]);
        assert_eq!(subpath.as_deref(), Some("skills"));
        assert_eq!(selected, vec!["brand-guidelines".to_string()]);
    }

    #[test]
    fn complete_tree_deletes_a_skill_that_vanished_upstream() {
        let _provider = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let _home = HomeGuard::set(&home);
        installed_url_skill(
            &home,
            "brand-guidelines",
            "Brand guidelines",
            "Keep",
            "https://github.com/anthropics/skills/tree/main/skills",
            Some("skills"),
            &["brand-guidelines"],
        );

        let report = refresh_url_pack_from_dirs(
            "https://github.com/anthropics/skills",
            Vec::new(),
            &[user_target()],
            None,
            "skills",
            true,
        )
        .unwrap();
        assert_eq!(report.removed, vec!["Brand guidelines".to_string()]);
        assert!(report.missing.is_empty(), "{report:?}");
        assert!(report.renamed.is_empty(), "{report:?}");
        assert!(manifest_entries(&home).unwrap().entries.is_empty());
    }

    #[test]
    fn paperspine_refresh_keeps_the_selected_skill_and_lists_new_siblings() {
        let _provider = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let _home = HomeGuard::set(&home);
        let url = "https://github.com/WUBING2023/PaperSpine/tree/main/dist/claude/skills";
        installed_url_skill(
            &home,
            "paper-spine",
            "PaperSpine",
            "Original",
            url,
            Some("dist/claude/skills"),
            &["paper-spine"],
        );
        let root = temp.path().join("dist").join("claude").join("skills");
        write_skill(&root.join("paper-spine"), "PaperSpine", "Revised");
        write_skill(&root.join("citation-helper"), "Citation helper", "New");

        let report = refresh_url_pack_from_dirs(
            url,
            collect_dirs(&root),
            &[user_target()],
            None,
            "PaperSpine",
            true,
        )
        .unwrap();
        assert!(report.added.is_empty(), "{report:?}");
        assert_eq!(report.updated, vec!["PaperSpine".to_string()]);
        assert!(report.removed.is_empty(), "{report:?}");
        assert_eq!(report.available, vec!["Citation helper".to_string()]);
        let saved = manifest_entries(&home).unwrap().entries;
        assert_eq!(
            saved
                .iter()
                .map(|entry| entry.folder.clone())
                .collect::<Vec<_>>(),
            vec!["paper-spine".to_string()]
        );
        let (_, subpath, selected) = url_fields(&saved[0]);
        assert_eq!(subpath.as_deref(), Some("dist/claude/skills"));
        assert_eq!(selected, vec!["paper-spine".to_string()]);
    }

    #[test]
    fn renamed_upstream_folder_follows_declared_name_or_fingerprint() {
        let _provider = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let _home = HomeGuard::set(&home);
        installed_url_skill(
            &home,
            "brand-guidelines",
            "Brand guidelines",
            "Keep",
            "https://github.com/anthropics/skills/tree/main/skills/brand-guidelines",
            Some("skills/brand-guidelines"),
            &["brand-guidelines"],
        );
        let renamed = temp.path().join("brand_guidelines");
        write_skill(&renamed, "Brand guidelines", "Keep");

        let report = refresh_url_pack_from_dirs(
            "https://github.com/anthropics/skills",
            vec![renamed],
            &[user_target()],
            None,
            "skills",
            true,
        )
        .unwrap();
        assert!(report.removed.is_empty(), "{report:?}");
        assert!(report.renamed.is_empty(), "{report:?}");
        assert!(report.missing.is_empty(), "{report:?}");
        assert_eq!(report.updated, vec!["Brand guidelines".to_string()]);
        let saved = manifest_entries(&home).unwrap().entries;
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].folder, "brand_guidelines");
        let (url, subpath, selected) = url_fields(&saved[0]);
        assert!(url.contains("brand-guidelines"), "{url}");
        assert_eq!(subpath.as_deref(), Some("skills/brand-guidelines"));
        assert_eq!(selected, vec!["brand_guidelines".to_string()]);
        assert!(!skills_root(&home).join("brand-guidelines").exists());
    }

    #[test]
    fn unmatched_rename_keeps_the_installed_copy() {
        let _provider = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let _home = HomeGuard::set(&home);
        let destination = installed_url_skill(
            &home,
            "brand-guidelines",
            "Brand guidelines",
            "Keep",
            "https://github.com/anthropics/skills/tree/main/skills",
            Some("skills"),
            &["brand-guidelines"],
        );
        let renamed = temp.path().join("brand-voice");
        write_skill(&renamed, "Brand voice", "Different");

        let report = refresh_url_pack_from_dirs(
            "https://github.com/anthropics/skills",
            vec![renamed],
            &[user_target()],
            None,
            "skills",
            true,
        )
        .unwrap();
        assert!(report.removed.is_empty(), "{report:?}");
        assert!(report.added.is_empty(), "{report:?}");
        assert_eq!(report.renamed, vec!["Brand guidelines".to_string()]);
        assert_eq!(report.available, vec!["Brand voice".to_string()]);
        assert!(destination.join("SKILL.md").is_file());
        assert_eq!(
            manifest_entries(&home).unwrap().entries[0].folder,
            "brand-guidelines"
        );
    }

    #[test]
    fn display_name_change_updates_the_same_folder() {
        let _provider = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let _home = HomeGuard::set(&home);
        installed_url_skill(
            &home,
            "brand-guidelines",
            "Brand guidelines",
            "Keep",
            "https://github.com/anthropics/skills/tree/main/skills/brand-guidelines",
            Some("skills/brand-guidelines"),
            &["brand-guidelines"],
        );
        let same = temp.path().join("brand-guidelines");
        write_skill(&same, "Brand voice", "Keep");

        let report = refresh_url_pack_from_dirs(
            "https://github.com/anthropics/skills",
            vec![same],
            &[user_target()],
            None,
            "skills",
            true,
        )
        .unwrap();
        assert_eq!(report.updated, vec!["Brand voice".to_string()]);
        assert!(report.removed.is_empty(), "{report:?}");
        assert!(report.renamed.is_empty(), "{report:?}");
        assert!(report.missing.is_empty(), "{report:?}");
        let saved = manifest_entries(&home).unwrap().entries;
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].folder, "brand-guidelines");
        assert_eq!(saved[0].declared_name, "Brand voice");
    }

    #[test]
    fn selected_folder_match_is_case_insensitive() {
        let _provider = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let _home = HomeGuard::set(&home);
        installed_url_skill(
            &home,
            "brand-guidelines",
            "Brand guidelines",
            "Keep",
            "https://github.com/anthropics/skills/tree/main/skills/brand-guidelines",
            Some("skills/brand-guidelines"),
            &["Brand-Guidelines"],
        );
        let same = temp.path().join("brand-guidelines");
        write_skill(&same, "Brand guidelines", "Revised");

        let report = refresh_url_pack_from_dirs(
            "https://github.com/anthropics/skills",
            vec![same],
            &[user_target()],
            None,
            "skills",
            true,
        )
        .unwrap();
        assert!(report.missing.is_empty(), "{report:?}");
        assert!(report.removed.is_empty(), "{report:?}");
        assert_eq!(report.updated, vec!["Brand guidelines".to_string()]);
        let saved = manifest_entries(&home).unwrap().entries;
        assert_eq!(saved[0].folder, "brand-guidelines");
        let (_, _, selected) = url_fields(&saved[0]);
        assert_eq!(selected, vec!["brand-guidelines".to_string()]);
    }

    #[test]
    fn backslash_subpath_is_normalized_to_forward_slashes() {
        let brand = bare_url_entry(
            "brand-guidelines",
            "https://github.com/anthropics/skills/tree/main/skills/brand-guidelines",
        );
        let mut canvas = bare_url_entry(
            "canvas-design",
            "https://github.com/anthropics/skills/tree/main/skills/canvas-design",
        );
        if let SkillSource::Url { subpath, .. } = &mut canvas.source {
            *subpath = Some("skills\\canvas-design".into());
        }
        let mut brand = brand;
        if let SkillSource::Url { subpath, .. } = &mut brand.source {
            *subpath = Some("skills\\brand-guidelines".into());
        }
        let scope = url_refresh_scope("https://github.com/anthropics/skills", &[brand, canvas]);
        assert_eq!(scope.extract_subpath.as_deref(), Some("skills"));

        let _provider = crate::providers::paths::lock_provider_env();
        let _guard = env_lock().lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        fs::create_dir_all(&home).unwrap();
        let _home = HomeGuard::set(&home);
        installed_url_skill(
            &home,
            "paper-spine",
            "PaperSpine",
            "Keep",
            "https://github.com/WUBING2023/PaperSpine",
            Some("dist\\claude\\skills"),
            &["paper-spine"],
        );
        let skill = temp.path().join("paper-spine");
        write_skill(&skill, "PaperSpine", "Keep");
        let report = refresh_url_pack_from_dirs(
            "https://github.com/WUBING2023/PaperSpine",
            vec![skill],
            &[user_target()],
            None,
            "PaperSpine",
            true,
        )
        .unwrap();
        assert!(report.missing.is_empty(), "{report:?}");
        let (_, subpath, _) = url_fields(&manifest_entries(&home).unwrap().entries[0]);
        assert_eq!(subpath.as_deref(), Some("dist/claude/skills"));
    }
}
