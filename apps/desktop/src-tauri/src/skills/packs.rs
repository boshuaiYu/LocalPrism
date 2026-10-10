use crate::skills::domain::{SkillImportOutcome, SkillScope, SkillTarget};
use crate::skills::import::{self, config_dir};
use crate::skills::manifest::{
    stable_entry_id, ManagedSkillEntry, ManifestStore, SkillManifest, SkillSource,
};
use crate::skills::paths::validate_skill_slug;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

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
    std::fs::rename(&tmp, &path)
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

pub(crate) fn github_repo(url: &str) -> Option<(String, String)> {
    parse_github_repo(url).map(|repo| (repo.owner, repo.repo))
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
    matches!(
        parse_github_repo(url)
            .as_ref()
            .map(|repo| repo.repo.as_str()),
        Some("scientific-agent-skills" | "claude-scientific-skills")
    )
}

pub(crate) fn is_retired_scientific_source(source: &SkillSource) -> bool {
    match source {
        SkillSource::Url { url } => is_scientific_repo_url(url),
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
        SkillSource::Url { url } => default_pack_id_from_url(url),
        SkillSource::Curated { package_id } => default_pack_ids()
            .iter()
            .copied()
            .find(|id| *id == package_id),
        SkillSource::Folder { .. } => None,
    }
}

fn folder_matches_default_pack(folder: &str, pack_id: &str) -> bool {
    let key = folder.trim().to_ascii_lowercase();
    match pack_id {
        "paper-spine" => matches!(
            key.as_str(),
            "paper-spine" | "paperspine" | "paper-spine-intake"
        ),
        "academic-research-skills" => {
            matches!(
                key.as_str(),
                "deep-research"
                    | "academic-paper"
                    | "academic-paper-reviewer"
                    | "academic-pipeline"
                    | "academic-research-suite"
                    | "literature-review"
                    | "peer-review"
                    | "reference-checker"
            ) || key.starts_with("academic-")
                || key.starts_with("academic_")
        }
        "nature-skills" => {
            matches!(
                key.as_str(),
                "nature-polishing" | "nature-figure" | "nature-writing" | "nature-citation"
            ) || key.starts_with("nature-")
                || key.starts_with("nature_")
        }
        "paper-humanizer-skill" => key == "paper-humanizer" || key.starts_with("paper-humanizer"),
        _ => false,
    }
}

fn entry_belongs_to_default_pack(entry: &ManagedSkillEntry, pack_id: &str) -> bool {
    if let Some(id) = default_pack_id_from_source(&entry.source) {
        return id == pack_id;
    }
    if matches!(
        entry.source,
        SkillSource::Url { .. } | SkillSource::Curated { .. }
    ) {
        return false;
    }
    folder_matches_default_pack(&entry.folder, pack_id)
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
        (SkillSource::Url { url: left }, SkillSource::Url { url: right }) => {
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
    normalize_folder_key(left) == normalize_folder_key(right)
}

fn normalize_folder_key(path: &str) -> String {
    let mut value = path.trim().replace('\\', "/");
    while value.ends_with('/') {
        value.pop();
    }
    value
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
            SkillSource::Url { url: recorded } => urls_same_pack(recorded, url),
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
    let store = ManifestStore::new(config);
    let manifest = store
        .load()
        .map_err(|error| format!("Failed to read skill manifest: {error}"))?;
    let mut removed = Vec::new();
    for entry in manifest.entries.iter().filter(|entry| predicate(entry)) {
        delete_skill_destination(entry)?;
        store
            .remove(&entry.id)
            .map_err(|error| format!("Failed to remove {}: {error}", entry.folder))?;
        removed.push(entry.declared_name.clone());
    }
    removed.sort();
    removed.dedup();
    Ok(removed)
}

fn delete_skill_destination(entry: &ManagedSkillEntry) -> Result<(), String> {
    if validate_skill_slug(&entry.folder).is_err() {
        return Err(format!(
            "Refusing to delete skill {}: invalid folder name",
            entry.folder
        ));
    }
    let dest = PathBuf::from(&entry.destination);
    if !dest.is_absolute() {
        return Err(format!(
            "Refusing to delete skill {}: destination is not absolute",
            entry.folder
        ));
    }
    if dest
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(format!(
            "Refusing to delete skill {}: destination is not contained",
            entry.folder
        ));
    }
    let basename = dest
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if basename != entry.folder {
        return Err(format!(
            "Refusing to delete skill {}: destination does not match the folder",
            entry.folder
        ));
    }
    let parent = dest
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str());
    if parent != Some("skills") && parent != Some(".skills") {
        return Err(format!(
            "Refusing to delete skill {}: destination is outside the skills directory",
            entry.folder
        ));
    }
    if !dest.exists() {
        return Ok(());
    }
    let metadata = std::fs::symlink_metadata(&dest)
        .map_err(|error| format!("Failed to inspect {}: {error}", dest.display()))?;
    if metadata.file_type().is_symlink() {
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
            "The recorded folder is gone: {}",
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

pub(crate) fn report_from_outcome(
    id: &str,
    name: &str,
    outcome: SkillImportOutcome,
    removed: Vec<String>,
) -> SkillPackUpdateReport {
    let mut report = SkillPackUpdateReport::named(id, name);
    report.added = outcome.added;
    report.updated = outcome.updated;
    report.unchanged = outcome.unchanged;
    report.removed = removed;
    if !outcome.errors.is_empty() {
        report.error = Some(outcome.errors.join("\n"));
        report.error_code = Some("import".into());
    }
    report
}

pub(crate) fn manifest_entries(config: &Path) -> Result<SkillManifest, String> {
    ManifestStore::new(config)
        .load()
        .map_err(|error| format!("Failed to read skill manifest: {error}"))
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

    fn hash() -> String {
        "a".repeat(64)
    }

    fn user_target() -> SkillTarget {
        SkillTarget {
            runtime: RuntimeKind::Claude,
            scope: SkillScope::User,
        }
    }

    fn entry(root: &Path, folder: &str, name: &str, source: SkillSource) -> ManagedSkillEntry {
        let destination = root.join("skills").join(folder);
        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("SKILL.md"), format!("# {name}\n")).unwrap();
        let target = user_target();
        ManagedSkillEntry {
            id: stable_entry_id(&target, folder).unwrap(),
            declared_name: name.into(),
            folder: folder.into(),
            source,
            content_sha256: hash(),
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
            SkillSource::Url {
                url: "https://github.com/K-Dense-AI/scientific-agent-skills".into(),
            },
        );
        let legacy = entry(
            &home,
            "anndata",
            "AnnData",
            SkillSource::Url {
                url: "https://github.com/K-Dense-AI/claude-scientific-skills/tree/main/skills"
                    .into(),
            },
        );
        let nature = entry(
            &home,
            "nature-polishing",
            "Nature polishing",
            SkillSource::Url {
                url: "https://github.com/Yuan1z0825/nature-skills/tree/main/skills".into(),
            },
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
            SkillSource::Url {
                url: "https://github.com/K-Dense-AI/scientific-agent-skills".into(),
            },
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
        assert!(report.detail.unwrap().contains("missing-pack"));
    }

    fn write_skill(dir: &Path, name: &str, description: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n# {name}\n"),
        )
        .unwrap();
    }
}
