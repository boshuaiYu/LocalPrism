use git2::{DiffOptions, IndexAddOption, Oid, Repository, RepositoryInitOptions, Signature, Sort};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

// ─── Types ───

#[derive(Serialize, Clone)]
pub struct SnapshotInfo {
    pub id: String,
    pub message: String,
    pub timestamp: i64,
    pub labels: Vec<String>,
    pub changed_files: Vec<String>,
}

#[derive(Serialize)]
pub struct FileDiff {
    pub file_path: String,
    pub status: String, // "added" | "modified" | "deleted"
    pub old_content: Option<String>,
    pub new_content: Option<String>,
}

// ─── Helpers ───

fn history_path(project_root: &str) -> PathBuf {
    Path::new(project_root)
        .join(".claudeprism")
        .join("history.git")
}

fn metadata_is_unsafe_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn require_unlinked_dir(project_root: &Path, path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to inspect {label}: {error}")),
        Ok(metadata) if metadata_is_unsafe_link(&metadata) => Err(format!(
            "Refusing to follow a linked {label}: {}",
            path.display()
        )),
        Ok(metadata) if metadata.is_dir() => {
            if path_is_inside(project_root, path)? {
                Ok(())
            } else {
                Err(format!(
                    "Refusing to use a {label} outside the project: {}",
                    path.display()
                ))
            }
        }
        Ok(_) => Err(format!(
            "Refusing to use a non-directory {label}: {}",
            path.display()
        )),
    }
}

fn require_unlinked_file(project_root: &Path, path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to inspect {label}: {error}")),
        Ok(metadata) if metadata_is_unsafe_link(&metadata) => Err(format!(
            "Refusing to follow a linked {label}: {}",
            path.display()
        )),
        Ok(metadata) if metadata.is_file() => {
            if path_is_inside(project_root, path)? {
                Ok(())
            } else {
                Err(format!(
                    "Refusing to use a {label} outside the project: {}",
                    path.display()
                ))
            }
        }
        Ok(_) => Err(format!(
            "Refusing to use a non-file {label}: {}",
            path.display()
        )),
    }
}

fn parse_git_pointer(content: &str, pointer_file: &Path) -> Option<PathBuf> {
    let line = content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    let raw = match (line.get(..7), line.get(7..)) {
        (Some(prefix), Some(rest)) if prefix.eq_ignore_ascii_case("gitdir:") => rest.trim(),
        _ => line,
    };
    if raw.is_empty() {
        return None;
    }
    let target = PathBuf::from(raw);
    Some(if target.is_absolute() {
        target
    } else {
        pointer_file.parent().unwrap_or(Path::new(".")).join(target)
    })
}

fn refuse_external_git_pointer(
    path: &Path,
    project_root: &Path,
    label: &str,
) -> Result<(), String> {
    require_unlinked_file(project_root, path, label)?;
    let Ok(content) = fs::read_to_string(path) else {
        return Ok(());
    };
    let Some(target) = parse_git_pointer(&content, path) else {
        return Ok(());
    };
    match path_is_inside(project_root, &target) {
        Ok(true) => Ok(()),
        Ok(false) | Err(_) => Err(format!(
            "Refusing to follow a {label} outside the project: {}",
            target.display()
        )),
    }
}

fn assert_history_artifacts_are_local(project_root: &Path) -> Result<(), String> {
    let claudeprism = project_root.join(".claudeprism");
    let git_dir = claudeprism.join("history.git");
    let nested_git = git_dir.join(".git");
    require_unlinked_dir(project_root, &claudeprism, ".claudeprism directory")?;
    require_unlinked_dir(project_root, &git_dir, "history.git repository")?;
    require_unlinked_dir(project_root, &nested_git, "history gitdir")?;
    require_unlinked_file(project_root, &git_dir.join("config"), "history.git config")?;
    require_unlinked_file(
        project_root,
        &nested_git.join("config"),
        "history git config",
    )?;
    require_unlinked_file(
        project_root,
        &claudeprism.join("history-exclude"),
        "history-exclude file",
    )?;
    refuse_external_git_pointer(
        &git_dir.join("commondir"),
        project_root,
        "history commondir",
    )?;
    refuse_external_git_pointer(
        &nested_git.join("commondir"),
        project_root,
        "history commondir",
    )?;
    refuse_external_git_pointer(
        &git_dir.join("gitdir"),
        project_root,
        "history gitdir pointer",
    )?;
    refuse_external_git_pointer(
        &nested_git.join("gitdir"),
        project_root,
        "history gitdir pointer",
    )?;
    Ok(())
}

fn path_is_inside(root: &Path, candidate: &Path) -> Result<bool, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve project root: {error}"))?;
    let candidate = candidate
        .canonicalize()
        .map_err(|error| format!("Failed to resolve {}: {error}", candidate.display()))?;
    Ok(candidate.starts_with(&root))
}

fn assert_opened_repo_is_local(project_root: &Path, repo: &Repository) -> Result<(), String> {
    if !path_is_inside(project_root, repo.path())? {
        return Err(format!(
            "Refusing to use a history repository outside the project: {}",
            repo.path().display()
        ));
    }
    if !path_is_inside(project_root, repo.commondir())? {
        return Err(format!(
            "Refusing to use a history commondir outside the project: {}",
            repo.commondir().display()
        ));
    }
    for config in [repo.path().join("config"), repo.commondir().join("config")] {
        require_unlinked_file(project_root, &config, "history git config")?;
    }
    Ok(())
}

fn ensure_local_dir(project_root: &Path, path: &Path) -> Result<(), String> {
    require_unlinked_dir(project_root, path, "directory")?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata_is_unsafe_link(&metadata) => Err(format!(
            "Refusing to follow a linked directory: {}",
            path.display()
        )),
        Ok(metadata) if metadata.is_dir() => {
            if path_is_inside(project_root, path)? {
                Ok(())
            } else {
                Err(format!(
                    "Refusing to create history outside the project: {}",
                    path.display()
                ))
            }
        }
        Ok(_) => Err(format!("Not a directory: {}", path.display())),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            fs::create_dir_all(path)
                .map_err(|error| format!("Failed to create {}: {error}", path.display()))?;
            match fs::symlink_metadata(path) {
                Ok(metadata) if metadata_is_unsafe_link(&metadata) => Err(format!(
                    "Refusing to follow a linked directory: {}",
                    path.display()
                )),
                Ok(metadata) if metadata.is_dir() => {
                    if path_is_inside(project_root, path)? {
                        Ok(())
                    } else {
                        Err(format!(
                            "Refusing to create history outside the project: {}",
                            path.display()
                        ))
                    }
                }
                Ok(_) => Err(format!("Not a directory: {}", path.display())),
                Err(error) => Err(format!("Failed to inspect {}: {error}", path.display())),
            }
        }
        Err(error) => Err(format!("Failed to inspect {}: {error}", path.display())),
    }
}

fn write_local_history_file(project_root: &Path, path: &Path, content: &str) -> Result<(), String> {
    require_unlinked_file(project_root, path, "history file")?;
    if let Some(parent) = path.parent() {
        require_unlinked_dir(project_root, parent, "history parent directory")?;
    }

    let tmp_name = format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("history")
    );
    let tmp = match path.parent() {
        Some(parent) => parent.join(tmp_name),
        None => PathBuf::from(tmp_name),
    };
    match fs::symlink_metadata(&tmp) {
        Ok(metadata) if metadata_is_unsafe_link(&metadata) || metadata.is_file() => {
            fs::remove_file(&tmp)
                .map_err(|error| format!("Failed to replace temporary history file: {error}"))?;
        }
        Ok(_) => {
            return Err(format!(
                "Refusing to use a non-file temporary history path: {}",
                tmp.display()
            ));
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!("Failed to inspect temporary history file: {error}"));
        }
    }

    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|error| format!("Failed to create temporary history file: {error}"))?;
        file.write_all(content.as_bytes())
            .map_err(|error| format!("Failed to write temporary history file: {error}"))?;
    }

    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata_is_unsafe_link(&metadata) => {
            let _ = fs::remove_file(&tmp);
            return Err(format!(
                "Refusing to follow a linked history file: {}",
                path.display()
            ));
        }
        Ok(metadata) if !metadata.is_file() => {
            let _ = fs::remove_file(&tmp);
            return Err(format!(
                "Refusing to use a non-file history path: {}",
                path.display()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            let _ = fs::remove_file(&tmp);
            return Err(format!("Failed to inspect history file: {error}"));
        }
    }

    fs::rename(&tmp, path).map_err(|error| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to install history file: {error}")
    })?;
    if !path_is_inside(project_root, path)? {
        return Err(format!(
            "Refusing to install a history file outside the project: {}",
            path.display()
        ));
    }
    Ok(())
}

fn rebind_persisted_workdir_before_open(
    project_root: &Path,
    repo_root: &Path,
) -> Result<(), String> {
    if !project_root.is_dir() {
        return Err(format!(
            "History workdir does not exist: {}",
            project_root.display()
        ));
    }
    assert_history_artifacts_are_local(project_root)?;

    // libgit2 resolves core.worktree while opening the repository. On Windows,
    // opening fails before we receive a Repository handle when a moved project
    // leaves that absolute path pointing at the old, now-missing directory.
    // Repair only the persisted worktree entry in our known internal layout so
    // the normal open + live-handle binding below can proceed.
    let config_path = [
        repo_root.join(".git").join("config"),
        repo_root.join("config"),
    ]
    .into_iter()
    .map(|candidate| match fs::symlink_metadata(&candidate) {
        Ok(metadata) if metadata_is_unsafe_link(&metadata) => Err(format!(
            "Refusing to follow a linked history git config: {}",
            candidate.display()
        )),
        Ok(metadata) if metadata.is_file() => Ok(Some(candidate)),
        Ok(_) => Err(format!(
            "Refusing to use a non-file history git config: {}",
            candidate.display()
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to inspect history git config: {error}")),
    })
    .collect::<Result<Vec<_>, _>>()?
    .into_iter()
    .flatten()
    .next();
    let Some(config_path) = config_path else {
        return Ok(());
    };
    if !path_is_inside(project_root, &config_path)? {
        return Err(format!(
            "Refusing to rewrite a history git config outside the project: {}",
            config_path.display()
        ));
    }

    let mut config = git2::Config::open(&config_path)
        .map_err(|e| format!("Failed to open history repo config: {}", e))?;
    let Ok(configured_workdir) = config.get_path("core.worktree") else {
        return Ok(());
    };
    if matches!(
        (project_root.canonicalize(), configured_workdir.canonicalize()),
        (Ok(expected), Ok(actual)) if expected == actual
    ) {
        return Ok(());
    }

    config
        .set_str("core.worktree", &project_root.to_string_lossy())
        .map_err(|e| format!("Failed to prebind history workdir: {}", e))
}

fn open_repo(project_root: &str) -> Result<Repository, String> {
    let project = Path::new(project_root);
    assert_history_artifacts_are_local(project)?;
    let git_dir = history_path(project_root);
    rebind_persisted_workdir_before_open(project, &git_dir)?;
    let repo =
        Repository::open(&git_dir).map_err(|e| format!("Failed to open history repo: {}", e))?;
    assert_opened_repo_is_local(project, &repo)?;
    bind_repo_workdir(project_root, &repo)?;
    Ok(repo)
}

fn repo_workdir_matches(project_root: &Path, repo: &Repository) -> bool {
    let Some(repo_workdir) = repo.workdir() else {
        return false;
    };
    match (project_root.canonicalize(), repo_workdir.canonicalize()) {
        (Ok(expected), Ok(actual)) => expected == actual,
        _ => false,
    }
}

fn bind_repo_workdir(project_root: &str, repo: &Repository) -> Result<(), String> {
    let project_root = Path::new(project_root);
    if !project_root.is_dir() {
        return Err(format!(
            "History workdir does not exist: {}",
            project_root.display()
        ));
    }
    assert_opened_repo_is_local(project_root, repo)?;
    if repo_workdir_matches(project_root, repo) {
        return Ok(());
    }

    // The history gitdir moves with the project, but libgit2 stores this
    // non-standard worktree as an absolute core.worktree path. Rebind both the
    // live handle and persisted config after a project-directory rename. Do not
    // update the gitlink because the project may have its own .git file.
    repo.set_workdir(project_root, false)
        .map_err(|e| format!("Failed to rebind history workdir: {}", e))?;
    repo.config()
        .and_then(|mut config| config.set_str("core.worktree", &project_root.to_string_lossy()))
        .map_err(|e| format!("Failed to persist history workdir: {}", e))?;
    Ok(())
}

fn default_signature() -> Result<Signature<'static>, String> {
    Signature::now("LocalPrism", "history@claudeprism.local")
        .map_err(|e| format!("Failed to create signature: {}", e))
}

/// Build a map of tag name → commit OID for quick label lookup
fn tag_map(repo: &Repository) -> HashMap<Oid, Vec<String>> {
    let mut map: HashMap<Oid, Vec<String>> = HashMap::new();
    if let Ok(tags) = repo.tag_names(None) {
        for tag_name in tags.iter().flatten() {
            if let Ok(reference) = repo.revparse_single(tag_name) {
                let oid = reference
                    .peel_to_commit()
                    .map(|c| c.id())
                    .unwrap_or(reference.id());
                map.entry(oid).or_default().push(tag_name.to_string());
            }
        }
    }
    map
}

fn ensure_excludes(project_root: &str, repo: &Repository) -> Result<(), String> {
    let project = Path::new(project_root);
    assert_history_artifacts_are_local(project)?;
    assert_opened_repo_is_local(project, repo)?;
    let excludes_path = project.join(".claudeprism").join("history-exclude");
    let content = r#"# LaTeX build artifacts
*.aux
*.log
*.out
*.toc
*.lof
*.lot
*.fls
*.fdb_latexmk
*.synctex.gz
*.bbl
*.blg
*.nav
*.snm
*.vrb
*.bcf
*.run.xml

# Output
*.pdf

# OS files
.DS_Store
Thumbs.db

# Git
.git/

# LocalPrism internal
.claudeprism/
.prism/
"#;
    match fs::symlink_metadata(&excludes_path) {
        Ok(metadata) if metadata_is_unsafe_link(&metadata) => {
            return Err(format!(
                "Refusing to follow a linked history-exclude file: {}",
                excludes_path.display()
            ));
        }
        Ok(metadata) if metadata.is_file() => {
            if let Ok(existing) = fs::read_to_string(&excludes_path) {
                if !existing.contains(".prism/") {
                    write_local_history_file(project, &excludes_path, content)?;
                }
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            write_local_history_file(project, &excludes_path, content)?;
        }
        Err(error) => {
            return Err(format!("Failed to inspect history-exclude file: {error}"));
        }
        Ok(_) => {
            return Err(format!(
                "Refusing to use a non-file history-exclude path: {}",
                excludes_path.display()
            ));
        }
    }
    // Configure the repo to use this excludes file
    if let Ok(mut config) = repo.config() {
        let _ = config.set_str("core.excludesFile", &excludes_path.to_string_lossy());
    }
    Ok(())
}

// ─── Tauri Commands ───

#[tauri::command]
pub fn history_init(project_root: String) -> Result<(), String> {
    let project = Path::new(&project_root);
    assert_history_artifacts_are_local(project)?;
    let git_dir = history_path(&project_root);

    match fs::symlink_metadata(&git_dir) {
        Ok(metadata) if metadata_is_unsafe_link(&metadata) => {
            return Err(format!(
                "Refusing to follow a linked history.git repository: {}",
                git_dir.display()
            ));
        }
        Ok(metadata) if metadata.is_dir() => {
            // Already initialized — verify and ensure excludes
            let repo = open_repo(&project_root)?;
            ensure_excludes(&project_root, &repo)?;
            return Ok(());
        }
        Ok(_) => {
            return Err(format!(
                "Refusing to use a non-directory history.git repository: {}",
                git_dir.display()
            ));
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!("Failed to inspect history.git: {error}"));
        }
    }

    let claudeprism_dir = project.join(".claudeprism");
    ensure_local_dir(project, &claudeprism_dir)?;

    // Init a bare repo with workdir pointing to project root
    let mut opts = RepositoryInitOptions::new();
    opts.bare(false);
    opts.workdir_path(project);
    opts.no_reinit(true);

    let repo = Repository::init_opts(&git_dir, &opts)
        .map_err(|e| format!("Failed to init history repo: {}", e))?;
    assert_opened_repo_is_local(project, &repo)?;
    bind_repo_workdir(&project_root, &repo)?;

    // Set up excludes file
    ensure_excludes(&project_root, &repo)?;

    // Create initial commit with all project files
    let mut index = repo
        .index()
        .map_err(|e| format!("Failed to get index: {}", e))?;

    // Add all files (respecting .gitignore)
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("Failed to add files: {}", e))?;
    index
        .write()
        .map_err(|e| format!("Failed to write index: {}", e))?;

    let tree_oid = index
        .write_tree()
        .map_err(|e| format!("Failed to write tree: {}", e))?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| format!("Failed to find tree: {}", e))?;

    let sig = default_signature()?;
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        "[init] Project opened",
        &tree,
        &[],
    )
    .map_err(|e| format!("Failed to create initial commit: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn history_snapshot(
    project_root: String,
    message: String,
) -> Result<Option<SnapshotInfo>, String> {
    let repo = open_repo(&project_root)?;

    let mut index = repo
        .index()
        .map_err(|e| format!("Failed to get index: {}", e))?;

    // Stage all changes
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("Failed to add files: {}", e))?;

    // Remove deleted files from index
    let workdir = repo.workdir().ok_or("No workdir")?;
    let entries: Vec<_> = index.iter().map(|e| e.path.clone()).collect();
    for path_bytes in &entries {
        let path_str = String::from_utf8_lossy(path_bytes);
        let full_path = workdir.join(path_str.as_ref());
        if !full_path.exists() {
            let _ = index.remove_path(Path::new(path_str.as_ref()));
        }
    }

    index
        .write()
        .map_err(|e| format!("Failed to write index: {}", e))?;

    let tree_oid = index
        .write_tree()
        .map_err(|e| format!("Failed to write tree: {}", e))?;

    // Check if there are actual changes vs HEAD
    if let Ok(head) = repo.head() {
        if let Ok(head_commit) = head.peel_to_commit() {
            if head_commit.tree().map(|t| t.id()).unwrap_or(Oid::zero()) == tree_oid {
                // No changes — skip snapshot
                return Ok(None);
            }
        }
    }

    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| format!("Failed to find tree: {}", e))?;

    let sig = default_signature()?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
        .map_err(|e| format!("Failed to create commit: {}", e))?;

    // Collect changed file paths
    let changed_files = if let Some(parent_commit) = parent.as_ref() {
        let parent_tree = parent_commit.tree().ok();
        repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
            .map(|d| {
                d.deltas()
                    .filter_map(|delta| {
                        delta
                            .new_file()
                            .path()
                            .or_else(|| delta.old_file().path())
                            .map(|p| p.to_string_lossy().to_string())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    } else {
        vec![]
    };

    Ok(Some(SnapshotInfo {
        id: oid.to_string(),
        message,
        timestamp: chrono::Utc::now().timestamp(),
        labels: vec![],
        changed_files,
    }))
}

#[tauri::command]
pub fn history_list(
    project_root: String,
    limit: u32,
    offset: u32,
) -> Result<Vec<SnapshotInfo>, String> {
    let repo = open_repo(&project_root)?;
    let tags = tag_map(&repo);

    let mut revwalk = repo
        .revwalk()
        .map_err(|e| format!("Failed to create revwalk: {}", e))?;
    revwalk
        .push_head()
        .map_err(|e| format!("Failed to push HEAD: {}", e))?;
    revwalk
        .set_sorting(Sort::TIME)
        .map_err(|e| format!("Sort error: {}", e))?;

    let mut snapshots = Vec::new();
    let mut count = 0u32;

    for oid_result in revwalk {
        let oid = oid_result.map_err(|e| format!("Revwalk error: {}", e))?;

        if count < offset {
            count += 1;
            continue;
        }
        if snapshots.len() >= limit as usize {
            break;
        }

        let commit = repo
            .find_commit(oid)
            .map_err(|e| format!("Failed to find commit: {}", e))?;

        let message = commit.message().unwrap_or("").to_string();
        let timestamp = commit.time().seconds();
        let labels = tags.get(&oid).cloned().unwrap_or_default();

        // Collect changed file paths (vs parent)
        let changed_files = if let Some(parent) = commit.parents().next() {
            let old_tree = parent.tree().ok();
            let new_tree = commit.tree().ok();
            repo.diff_tree_to_tree(old_tree.as_ref(), new_tree.as_ref(), None)
                .map(|d| {
                    d.deltas()
                        .filter_map(|delta| {
                            delta
                                .new_file()
                                .path()
                                .or_else(|| delta.old_file().path())
                                .map(|p| p.to_string_lossy().to_string())
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        } else {
            vec![]
        };

        snapshots.push(SnapshotInfo {
            id: oid.to_string(),
            message,
            timestamp,
            labels,
            changed_files,
        });

        count += 1;
    }

    Ok(snapshots)
}

#[tauri::command]
pub fn history_diff(
    project_root: String,
    from_id: String,
    to_id: String,
) -> Result<Vec<FileDiff>, String> {
    let repo = open_repo(&project_root)?;

    let from_oid = Oid::from_str(&from_id).map_err(|e| format!("Invalid from_id: {}", e))?;
    let to_oid = Oid::from_str(&to_id).map_err(|e| format!("Invalid to_id: {}", e))?;

    let from_commit = repo
        .find_commit(from_oid)
        .map_err(|e| format!("Commit not found: {}", e))?;
    let to_commit = repo
        .find_commit(to_oid)
        .map_err(|e| format!("Commit not found: {}", e))?;

    let from_tree = from_commit
        .tree()
        .map_err(|e| format!("Tree error: {}", e))?;
    let to_tree = to_commit.tree().map_err(|e| format!("Tree error: {}", e))?;

    let mut diff_opts = DiffOptions::new();
    let diff = repo
        .diff_tree_to_tree(Some(&from_tree), Some(&to_tree), Some(&mut diff_opts))
        .map_err(|e| format!("Diff error: {}", e))?;

    let mut results = Vec::new();

    for delta in diff.deltas() {
        let file_path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let status = match delta.status() {
            git2::Delta::Added => "added",
            git2::Delta::Deleted => "deleted",
            _ => "modified",
        }
        .to_string();

        let old_content = if delta.status() != git2::Delta::Added {
            let old_blob = repo.find_blob(delta.old_file().id()).ok();
            old_blob.and_then(|b| {
                if b.is_binary() {
                    None
                } else {
                    Some(String::from_utf8_lossy(b.content()).to_string())
                }
            })
        } else {
            None
        };

        let new_content = if delta.status() != git2::Delta::Deleted {
            let new_blob = repo.find_blob(delta.new_file().id()).ok();
            new_blob.and_then(|b| {
                if b.is_binary() {
                    None
                } else {
                    Some(String::from_utf8_lossy(b.content()).to_string())
                }
            })
        } else {
            None
        };

        results.push(FileDiff {
            file_path,
            status,
            old_content,
            new_content,
        });
    }

    Ok(results)
}

#[tauri::command]
pub fn history_file_at(
    project_root: String,
    snapshot_id: String,
    file_path: String,
) -> Result<String, String> {
    let repo = open_repo(&project_root)?;
    let oid = Oid::from_str(&snapshot_id).map_err(|e| format!("Invalid snapshot_id: {}", e))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("Commit not found: {}", e))?;
    let tree = commit.tree().map_err(|e| format!("Tree error: {}", e))?;
    let entry = tree
        .get_path(Path::new(&file_path))
        .map_err(|e| format!("File not found in snapshot: {}", e))?;
    let blob = repo
        .find_blob(entry.id())
        .map_err(|e| format!("Blob error: {}", e))?;

    if blob.is_binary() {
        return Err("Binary file".into());
    }

    Ok(String::from_utf8_lossy(blob.content()).to_string())
}

#[tauri::command]
pub fn history_restore(project_root: String, snapshot_id: String) -> Result<SnapshotInfo, String> {
    let repo = open_repo(&project_root)?;
    let oid = Oid::from_str(&snapshot_id).map_err(|e| format!("Invalid snapshot_id: {}", e))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("Commit not found: {}", e))?;
    let tree = commit.tree().map_err(|e| format!("Tree error: {}", e))?;

    // Checkout the tree to working directory
    repo.checkout_tree(
        tree.as_object(),
        Some(git2::build::CheckoutBuilder::new().force()),
    )
    .map_err(|e| format!("Checkout failed: {}", e))?;

    // Create a new "restore" commit on HEAD (not moving HEAD to old commit)
    let mut index = repo.index().map_err(|e| format!("Index error: {}", e))?;
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("Add error: {}", e))?;
    index.write().map_err(|e| format!("Write error: {}", e))?;

    let new_tree_oid = index
        .write_tree()
        .map_err(|e| format!("Write tree error: {}", e))?;
    let new_tree = repo
        .find_tree(new_tree_oid)
        .map_err(|e| format!("Find tree error: {}", e))?;

    let sig = default_signature()?;
    let head_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = head_commit.iter().collect();

    let short_id = &snapshot_id[..8.min(snapshot_id.len())];
    let msg = format!("[restore] Restored to {}", short_id);
    let new_oid = repo
        .commit(Some("HEAD"), &sig, &sig, &msg, &new_tree, &parents)
        .map_err(|e| format!("Commit error: {}", e))?;

    Ok(SnapshotInfo {
        id: new_oid.to_string(),
        message: msg,
        timestamp: chrono::Utc::now().timestamp(),
        labels: vec![],
        changed_files: vec![],
    })
}

#[tauri::command]
pub fn history_add_label(
    project_root: String,
    snapshot_id: String,
    label: String,
) -> Result<(), String> {
    let repo = open_repo(&project_root)?;
    let oid = Oid::from_str(&snapshot_id).map_err(|e| format!("Invalid snapshot_id: {}", e))?;
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("Commit not found: {}", e))?;

    repo.tag_lightweight(&label, commit.as_object(), false)
        .map_err(|e| format!("Failed to create label: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn history_remove_label(project_root: String, label: String) -> Result<(), String> {
    let repo = open_repo(&project_root)?;
    let tag_ref = format!("refs/tags/{}", label);
    repo.find_reference(&tag_ref)
        .map_err(|e| format!("Label not found: {}", e))?
        .delete()
        .map_err(|e| format!("Failed to delete label: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Create a temp project dir with the given files.
    fn setup_project(files: &[(&str, &str)]) -> TempDir {
        let dir = TempDir::new().unwrap();
        for (name, content) in files {
            let path = dir.path().join(name);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, content).unwrap();
        }
        dir
    }

    fn root(dir: &TempDir) -> String {
        dir.path().to_string_lossy().to_string()
    }

    fn symlink_path(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            if target.is_dir() {
                std::os::windows::fs::symlink_dir(target, link).unwrap();
            } else {
                std::os::windows::fs::symlink_file(target, link).unwrap();
            }
        }
    }

    fn is_symlink(path: &Path) -> bool {
        fs::symlink_metadata(path)
            .map(|metadata| metadata_is_unsafe_link(&metadata))
            .unwrap_or(false)
    }

    #[cfg(windows)]
    fn create_directory_junction(target: &Path, link: &Path) -> std::io::Result<()> {
        let status = std::process::Command::new("cmd")
            .args([
                "/C",
                "mklink",
                "/J",
                &link.to_string_lossy(),
                &target.to_string_lossy(),
            ])
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other("mklink /J failed"))
        }
    }

    fn history_git_config(project: &Path) -> PathBuf {
        project
            .join(".claudeprism")
            .join("history.git")
            .join(".git")
            .join("config")
    }

    fn copy_dir(src: &Path, dst: &Path) {
        fs::create_dir_all(dst).unwrap();
        for entry in fs::read_dir(src).unwrap() {
            let entry = entry.unwrap();
            let dest = dst.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_dir(&entry.path(), &dest);
            } else {
                fs::copy(entry.path(), dest).unwrap();
            }
        }
    }

    fn assert_external_path_untouched(path: &Path, original: &str) {
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            original,
            "history initialization must not mutate {}",
            path.display()
        );
    }

    // ─── history_init ───

    #[test]
    fn test_history_init_creates_repo() {
        let dir = setup_project(&[("main.tex", "\\documentclass{article}")]);
        history_init(root(&dir)).unwrap();

        let git_dir = dir.path().join(".claudeprism").join("history.git");
        assert!(git_dir.exists(), "history.git should be created");

        // Should have an initial commit
        let repo = Repository::open(&git_dir).unwrap();
        let head = repo.head().unwrap();
        let commit = head.peel_to_commit().unwrap();
        assert!(commit.message().unwrap().contains("[init]"));
    }

    #[test]
    fn test_history_init_idempotent() {
        let dir = setup_project(&[("main.tex", "hello")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();
        // Second call should succeed without error
        history_init(r).unwrap();
    }

    #[test]
    fn test_history_rebinds_workdir_after_project_directory_rename() {
        let parent = TempDir::new().unwrap();
        let old_root = parent.path().join("old-project");
        let new_root = parent.path().join("renamed-project");
        fs::create_dir_all(&old_root).unwrap();
        fs::write(old_root.join("main.tex"), "version one").unwrap();

        let old_root_string = old_root.to_string_lossy().to_string();
        history_init(old_root_string.clone()).unwrap();
        let initial_id = history_list(old_root_string.clone(), 1, 0).unwrap()[0]
            .id
            .clone();
        let repo_before_rename = Repository::open(history_path(&old_root_string)).unwrap();
        assert!(repo_workdir_matches(&old_root, &repo_before_rename));
        drop(repo_before_rename);

        fs::rename(&old_root, &new_root).unwrap();
        let new_root_string = new_root.to_string_lossy().to_string();
        let stale_workdir =
            git2::Config::open(&history_path(&new_root_string).join(".git").join("config"))
                .unwrap()
                .get_path("core.worktree")
                .unwrap();
        assert_eq!(stale_workdir, old_root);
        history_init(new_root_string.clone()).unwrap();

        let repo = Repository::open(history_path(&new_root_string)).unwrap();
        let actual_workdir = repo
            .workdir()
            .expect("history repository must have a workdir")
            .canonicalize()
            .expect("history workdir must point at the renamed project");
        assert_eq!(actual_workdir, new_root.canonicalize().unwrap());
        let configured_excludes = repo
            .config()
            .unwrap()
            .get_path("core.excludesFile")
            .unwrap()
            .canonicalize()
            .unwrap();
        assert_eq!(
            configured_excludes,
            new_root
                .join(".claudeprism")
                .join("history-exclude")
                .canonicalize()
                .unwrap()
        );
        drop(repo);

        fs::write(new_root.join("main.tex"), "version two").unwrap();
        let snapshot = history_snapshot(new_root_string.clone(), "after rename".into())
            .unwrap()
            .expect("a change in the renamed project must be snapshotted");
        let diffs = history_diff(new_root_string.clone(), initial_id.clone(), snapshot.id).unwrap();
        assert_eq!(
            diffs
                .iter()
                .find(|diff| diff.file_path == "main.tex")
                .and_then(|diff| diff.new_content.as_deref()),
            Some("version two")
        );

        history_restore(new_root_string, initial_id).unwrap();
        assert_eq!(
            fs::read_to_string(new_root.join("main.tex")).unwrap(),
            "version one"
        );
        assert!(
            !old_root.exists(),
            "history operations must not recreate or write the old project root"
        );
    }

    #[test]
    fn test_history_init_creates_excludes() {
        let dir = setup_project(&[("main.tex", "doc")]);
        history_init(root(&dir)).unwrap();

        let excludes = dir.path().join(".claudeprism").join("history-exclude");
        assert!(excludes.exists());
        let content = fs::read_to_string(&excludes).unwrap();
        assert!(content.contains("*.aux"));
        assert!(content.contains(".claudeprism/"));
        assert!(content.contains(".prism/"));
    }

    #[test]
    fn test_history_keeps_working_for_a_real_in_project_layout() {
        let dir = setup_project(&[("main.tex", "\\documentclass{article}\n")]);
        let project = root(&dir);

        history_init(project.clone()).unwrap();
        history_init(project.clone()).unwrap();

        let claudeprism = dir.path().join(".claudeprism");
        let git_dir = claudeprism.join("history.git");
        let excludes = claudeprism.join("history-exclude");
        assert!(
            !is_symlink(&claudeprism) && claudeprism.is_dir(),
            ".claudeprism must remain a real in-project directory"
        );
        assert!(
            !is_symlink(&git_dir) && git_dir.is_dir(),
            "history.git must remain a real in-project repository"
        );
        assert!(
            !is_symlink(&excludes) && excludes.is_file(),
            "history-exclude must remain a real in-project file"
        );

        fs::write(
            dir.path().join("main.tex"),
            "\\documentclass{article}\n% edit\n",
        )
        .unwrap();
        let snapshot = history_snapshot(project.clone(), "[manual] Save".into())
            .unwrap()
            .expect("editing a real project file must create a history commit");
        assert!(snapshot.changed_files.contains(&"main.tex".to_string()));

        let list = history_list(project, 10, 0).unwrap();
        assert!(list.iter().any(|item| item.message.contains("[init]")));
        assert!(list.iter().any(|item| item.id == snapshot.id));
    }

    #[test]
    fn test_history_init_does_not_overwrite_external_file_through_exclude_symlink() {
        let outside = TempDir::new().unwrap();
        let victim = outside.path().join("victim-exclude.txt");
        let original = "keep this exclude file\n";
        fs::write(&victim, original).unwrap();

        let dir = setup_project(&[("main.tex", "doc")]);
        let claudeprism = dir.path().join(".claudeprism");
        fs::create_dir_all(&claudeprism).unwrap();
        symlink_path(&victim, &claudeprism.join("history-exclude"));

        let result = history_init(root(&dir));
        assert!(
            result.is_err(),
            "init must refuse a linked history-exclude, got {result:?}"
        );
        assert_external_path_untouched(&victim, original);
    }

    #[test]
    fn test_history_init_does_not_rebind_external_repo_through_history_git_symlink() {
        let victim = setup_project(&[("secret.tex", "classified")]);
        history_init(root(&victim)).unwrap();
        let victim_git = victim.path().join(".claudeprism").join("history.git");
        let config_before = fs::read_to_string(history_git_config(victim.path())).unwrap();
        let worktree_before = {
            let repo = Repository::open(&victim_git).unwrap();
            repo.workdir().unwrap().canonicalize().unwrap()
        };

        let attacker = setup_project(&[("main.tex", "attack")]);
        fs::create_dir_all(attacker.path().join(".claudeprism")).unwrap();
        symlink_path(
            &victim_git,
            &attacker.path().join(".claudeprism").join("history.git"),
        );

        let result = history_init(root(&attacker));
        assert!(
            result.is_err(),
            "init must refuse a linked history.git, got {result:?}"
        );
        assert_eq!(
            fs::read_to_string(history_git_config(victim.path())).unwrap(),
            config_before
        );
        let worktree_after = {
            let repo = Repository::open(&victim_git).unwrap();
            repo.workdir().unwrap().canonicalize().unwrap()
        };
        assert_eq!(worktree_before, worktree_after);
        assert_eq!(
            fs::read_to_string(victim.path().join("secret.tex")).unwrap(),
            "classified"
        );
    }

    #[test]
    fn test_history_init_does_not_rebind_external_repo_through_history_git_gitlink() {
        let victim = setup_project(&[("secret.tex", "classified")]);
        history_init(root(&victim)).unwrap();
        let victim_gitdir = victim
            .path()
            .join(".claudeprism")
            .join("history.git")
            .join(".git");
        let config_before = fs::read_to_string(history_git_config(victim.path())).unwrap();

        let attacker = setup_project(&[("main.tex", "attack")]);
        fs::create_dir_all(attacker.path().join(".claudeprism")).unwrap();
        fs::write(
            attacker.path().join(".claudeprism").join("history.git"),
            format!("gitdir: {}\n", victim_gitdir.display()),
        )
        .unwrap();

        let result = history_init(root(&attacker));
        assert!(
            result.is_err(),
            "init must refuse a history.git gitlink, got {result:?}"
        );
        assert_eq!(
            fs::read_to_string(history_git_config(victim.path())).unwrap(),
            config_before
        );
    }

    #[test]
    fn test_history_init_does_not_rebind_external_repo_through_nested_gitlink() {
        let victim = setup_project(&[("secret.tex", "classified")]);
        history_init(root(&victim)).unwrap();
        let victim_gitdir = victim
            .path()
            .join(".claudeprism")
            .join("history.git")
            .join(".git");
        let config_before = fs::read_to_string(history_git_config(victim.path())).unwrap();

        let attacker = setup_project(&[("main.tex", "attack")]);
        let fake_repo = attacker.path().join(".claudeprism").join("history.git");
        fs::create_dir_all(&fake_repo).unwrap();
        fs::write(
            fake_repo.join(".git"),
            format!("gitdir: {}\n", victim_gitdir.display()),
        )
        .unwrap();

        let result = history_init(root(&attacker));
        assert!(
            result.is_err(),
            "init must refuse a nested history gitlink, got {result:?}"
        );
        assert_eq!(
            fs::read_to_string(history_git_config(victim.path())).unwrap(),
            config_before
        );
    }

    #[test]
    fn test_history_init_does_not_create_history_through_claudeprism_dir_symlink() {
        let outside = TempDir::new().unwrap();
        let dir = setup_project(&[("main.tex", "doc")]);
        symlink_path(outside.path(), &dir.path().join(".claudeprism"));

        let result = history_init(root(&dir));
        assert!(
            result.is_err(),
            "init must refuse a linked .claudeprism directory, got {result:?}"
        );
        assert!(
            !outside.path().join("history.git").exists(),
            "history.git must not be created outside the project"
        );
        assert!(
            !outside.path().join("history-exclude").exists(),
            "history-exclude must not be written outside the project"
        );
        let leftover: Vec<_> = fs::read_dir(outside.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert!(
            leftover.is_empty(),
            "linked .claudeprism target must stay empty, found {leftover:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn test_history_init_does_not_create_history_through_claudeprism_junction() {
        let outside = TempDir::new().unwrap();
        let dir = setup_project(&[("main.tex", "doc")]);
        create_directory_junction(outside.path(), &dir.path().join(".claudeprism")).unwrap();

        let result = history_init(root(&dir));
        assert!(
            result.is_err(),
            "init must refuse a junctioned .claudeprism directory, got {result:?}"
        );
        assert!(
            !outside.path().join("history.git").exists(),
            "history.git must not be created outside the project"
        );
        assert!(
            !outside.path().join("history-exclude").exists(),
            "history-exclude must not be written outside the project"
        );
        let leftover: Vec<_> = fs::read_dir(outside.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert!(
            leftover.is_empty(),
            "junctioned .claudeprism target must stay empty, found {leftover:?}"
        );
    }

    #[test]
    fn test_history_init_does_not_overwrite_exclude_symlink_on_existing_repo() {
        let dir = setup_project(&[("main.tex", "doc")]);
        history_init(root(&dir)).unwrap();

        let outside = TempDir::new().unwrap();
        let victim = outside.path().join("victim-exclude.txt");
        let original = "do-not-migrate-me\n";
        fs::write(&victim, original).unwrap();

        let excludes = dir.path().join(".claudeprism").join("history-exclude");
        fs::remove_file(&excludes).unwrap();
        symlink_path(&victim, &excludes);

        let result = history_init(root(&dir));
        assert!(
            result.is_err(),
            "re-init must refuse a linked history-exclude, got {result:?}"
        );
        assert_external_path_untouched(&victim, original);
    }

    #[test]
    fn test_history_snapshot_does_not_rebind_external_repo_through_history_git_symlink() {
        let victim = setup_project(&[("secret.tex", "classified")]);
        history_init(root(&victim)).unwrap();
        let victim_git = victim.path().join(".claudeprism").join("history.git");
        let config_before = fs::read_to_string(history_git_config(victim.path())).unwrap();

        let attacker = setup_project(&[("main.tex", "attack")]);
        fs::create_dir_all(attacker.path().join(".claudeprism")).unwrap();
        symlink_path(
            &victim_git,
            &attacker.path().join(".claudeprism").join("history.git"),
        );
        fs::write(attacker.path().join("main.tex"), "changed").unwrap();

        let result = history_snapshot(root(&attacker), "should not touch victim".into());
        assert!(result.is_err(), "snapshot must refuse a linked history.git");
        assert_eq!(
            fs::read_to_string(history_git_config(victim.path())).unwrap(),
            config_before
        );
    }

    #[test]
    fn test_history_init_does_not_rebind_through_gitdir_root_config_symlink() {
        let victim = setup_project(&[("secret.tex", "classified")]);
        history_init(root(&victim)).unwrap();
        let victim_gitdir = victim
            .path()
            .join(".claudeprism")
            .join("history.git")
            .join(".git");
        let config_before = fs::read_to_string(history_git_config(victim.path())).unwrap();

        let attacker = setup_project(&[("main.tex", "attack")]);
        let planted = attacker.path().join(".claudeprism").join("history.git");
        copy_dir(&victim_gitdir, &planted);
        fs::remove_file(planted.join("config")).unwrap();
        symlink_path(&victim_gitdir.join("config"), &planted.join("config"));

        let result = history_init(root(&attacker));
        assert!(
            result.is_err(),
            "init must refuse a linked gitdir-root config, got {result:?}"
        );
        assert_eq!(
            fs::read_to_string(history_git_config(victim.path())).unwrap(),
            config_before
        );
    }

    #[test]
    fn test_history_init_does_not_rebind_through_external_commondir() {
        let victim = setup_project(&[("secret.tex", "classified")]);
        history_init(root(&victim)).unwrap();
        let victim_gitdir = victim
            .path()
            .join(".claudeprism")
            .join("history.git")
            .join(".git");
        let config_before = fs::read_to_string(history_git_config(victim.path())).unwrap();

        let attacker = setup_project(&[("main.tex", "attack")]);
        let fake_git = attacker
            .path()
            .join(".claudeprism")
            .join("history.git")
            .join(".git");
        fs::create_dir_all(&fake_git).unwrap();
        fs::write(fake_git.join("HEAD"), "ref: refs/heads/master\n").unwrap();
        fs::write(
            fake_git.join("commondir"),
            format!("{}\n", victim_gitdir.display()),
        )
        .unwrap();

        let result = history_init(root(&attacker));
        assert!(
            result.is_err(),
            "init must refuse an external commondir pointer, got {result:?}"
        );
        assert_eq!(
            fs::read_to_string(history_git_config(victim.path())).unwrap(),
            config_before
        );
    }

    // ─── history_snapshot ───

    #[test]
    fn test_history_snapshot_after_modification() {
        let dir = setup_project(&[("main.tex", "v1")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        // Modify a file
        fs::write(dir.path().join("main.tex"), "v2").unwrap();

        let result = history_snapshot(r, "edited main.tex".into()).unwrap();
        assert!(result.is_some());
        let snap = result.unwrap();
        assert_eq!(snap.message, "edited main.tex");
        assert!(snap.changed_files.contains(&"main.tex".to_string()));
    }

    #[test]
    fn test_history_snapshot_no_change_returns_none() {
        let dir = setup_project(&[("main.tex", "same")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        // No modification → None
        let result = history_snapshot(r, "no-op".into()).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_history_snapshot_detects_new_file() {
        let dir = setup_project(&[("main.tex", "doc")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        // Add a new file
        fs::write(dir.path().join("chapter1.tex"), "new chapter").unwrap();

        let snap = history_snapshot(r, "add chapter".into()).unwrap().unwrap();
        assert!(snap.changed_files.contains(&"chapter1.tex".to_string()));
    }

    // ─── history_list ───

    #[test]
    fn test_history_list_after_snapshots() {
        let dir = setup_project(&[("main.tex", "v1")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        fs::write(dir.path().join("main.tex"), "v2").unwrap();
        history_snapshot(r.clone(), "snap 1".into()).unwrap();

        fs::write(dir.path().join("main.tex"), "v3").unwrap();
        history_snapshot(r.clone(), "snap 2".into()).unwrap();

        let list = history_list(r, 10, 0).unwrap();
        assert_eq!(list.len(), 3); // init + 2 snapshots
        let msgs: Vec<&str> = list.iter().map(|s| s.message.as_str()).collect();
        assert!(msgs.contains(&"snap 1"));
        assert!(msgs.contains(&"snap 2"));
        assert!(msgs.iter().any(|m| m.contains("[init]")));
    }

    #[test]
    fn test_history_list_pagination() {
        let dir = setup_project(&[("a.tex", "x")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        fs::write(dir.path().join("a.tex"), "y").unwrap();
        history_snapshot(r.clone(), "s1".into()).unwrap();

        fs::write(dir.path().join("a.tex"), "z").unwrap();
        history_snapshot(r.clone(), "s2".into()).unwrap();

        // limit=1 → returns exactly 1 entry
        let page1 = history_list(r.clone(), 1, 0).unwrap();
        assert_eq!(page1.len(), 1);

        // offset=1 → returns a different entry
        let page2 = history_list(r.clone(), 1, 1).unwrap();
        assert_eq!(page2.len(), 1);
        assert_ne!(page1[0].id, page2[0].id);

        // All 3 entries accessible
        let all = history_list(r, 10, 0).unwrap();
        assert_eq!(all.len(), 3);
    }

    // ─── history_diff ───

    #[test]
    fn test_history_diff_shows_changes() {
        let dir = setup_project(&[("main.tex", "old content")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        fs::write(dir.path().join("main.tex"), "new content").unwrap();
        let snap = history_snapshot(r.clone(), "update".into())
            .unwrap()
            .unwrap();

        let list = history_list(r.clone(), 10, 0).unwrap();
        let from_id = list[1].id.clone(); // init
        let to_id = snap.id.clone();

        let diffs = history_diff(r, from_id, to_id).unwrap();
        assert!(!diffs.is_empty());
        let d = diffs.iter().find(|d| d.file_path == "main.tex").unwrap();
        assert_eq!(d.status, "modified");
        assert_eq!(d.old_content.as_deref(), Some("old content"));
        assert_eq!(d.new_content.as_deref(), Some("new content"));
    }

    #[test]
    fn test_history_diff_added_file() {
        let dir = setup_project(&[("a.tex", "a")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        fs::write(dir.path().join("b.tex"), "new file").unwrap();
        let snap = history_snapshot(r.clone(), "add b".into())
            .unwrap()
            .unwrap();

        let list = history_list(r.clone(), 10, 0).unwrap();
        let from_id = list[1].id.clone(); // init
        let to_id = snap.id;

        let diffs = history_diff(r, from_id, to_id).unwrap();
        let d = diffs.iter().find(|d| d.file_path == "b.tex").unwrap();
        assert_eq!(d.status, "added");
        assert!(d.old_content.is_none());
        assert_eq!(d.new_content.as_deref(), Some("new file"));
    }

    // ─── history_file_at ───

    #[test]
    fn test_history_file_at_returns_content() {
        let dir = setup_project(&[("main.tex", "version one")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let init_id = list[0].id.clone();

        let content = history_file_at(r, init_id, "main.tex".into()).unwrap();
        assert_eq!(content, "version one");
    }

    #[test]
    fn test_history_file_at_nonexistent_file_errors() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let id = list[0].id.clone();

        let result = history_file_at(r, id, "nonexistent.tex".into());
        assert!(result.is_err());
    }

    // ─── history_restore ───

    #[test]
    fn test_history_restore_reverts_content() {
        let dir = setup_project(&[("main.tex", "original")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let init_id = list[0].id.clone();

        // Modify
        fs::write(dir.path().join("main.tex"), "modified").unwrap();
        history_snapshot(r.clone(), "modify".into()).unwrap();

        // Restore to init
        let restore_info = history_restore(r.clone(), init_id).unwrap();
        assert!(restore_info.message.contains("[restore]"));

        // Working directory should have original content
        let content = fs::read_to_string(dir.path().join("main.tex")).unwrap();
        assert_eq!(content, "original");
    }

    // ─── labels ───

    #[test]
    fn test_history_add_and_remove_label() {
        let dir = setup_project(&[("main.tex", "doc")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let id = list[0].id.clone();

        // Add label
        history_add_label(r.clone(), id.clone(), "v1.0".into()).unwrap();

        // Verify label appears in list
        let list = history_list(r.clone(), 1, 0).unwrap();
        assert!(list[0].labels.contains(&"v1.0".to_string()));

        // Remove label
        history_remove_label(r.clone(), "v1.0".into()).unwrap();

        // Verify label gone
        let list = history_list(r.clone(), 1, 0).unwrap();
        assert!(!list[0].labels.contains(&"v1.0".to_string()));
    }

    #[test]
    fn test_history_remove_nonexistent_label_errors() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let result = history_remove_label(r, "nope".into());
        assert!(result.is_err());
    }

    // ─── tag_map ───

    #[test]
    fn test_tag_map_groups_by_oid() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let id = list[0].id.clone();

        history_add_label(r.clone(), id.clone(), "alpha".into()).unwrap();
        history_add_label(r.clone(), id.clone(), "beta".into()).unwrap();

        let repo = open_repo(&r).unwrap();
        let map = tag_map(&repo);
        let oid = Oid::from_str(&id).unwrap();
        let labels = map.get(&oid).unwrap();
        assert!(labels.contains(&"alpha".to_string()));
        assert!(labels.contains(&"beta".to_string()));
    }

    // ─── ensure_excludes ───

    #[test]
    fn test_ensure_excludes_migrates_missing_prism() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        // Write an excludes file WITHOUT .prism/
        let excludes_path = dir.path().join(".claudeprism").join("history-exclude");
        fs::write(&excludes_path, "*.aux\n*.log\n.claudeprism/\n").unwrap();

        let repo = open_repo(&r).unwrap();
        ensure_excludes(&r, &repo).unwrap();

        let content = fs::read_to_string(&excludes_path).unwrap();
        assert!(
            content.contains(".prism/"),
            "should migrate to include .prism/"
        );
    }

    // ─── edge cases ───

    #[test]
    fn test_history_snapshot_deleted_file() {
        let dir = setup_project(&[("a.tex", "aaa"), ("b.tex", "bbb")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        // Delete a file
        fs::remove_file(dir.path().join("b.tex")).unwrap();

        let snap = history_snapshot(r.clone(), "delete b".into())
            .unwrap()
            .unwrap();
        assert!(!snap.changed_files.is_empty());
    }

    #[test]
    fn test_history_diff_deleted_file() {
        let dir = setup_project(&[("a.tex", "keep"), ("b.tex", "remove me")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let init_id = list[0].id.clone();

        fs::remove_file(dir.path().join("b.tex")).unwrap();
        let snap = history_snapshot(r.clone(), "delete b".into())
            .unwrap()
            .unwrap();

        let diffs = history_diff(r, init_id, snap.id).unwrap();
        let d = diffs.iter().find(|d| d.file_path == "b.tex").unwrap();
        assert_eq!(d.status, "deleted");
        assert_eq!(d.old_content.as_deref(), Some("remove me"));
        assert!(d.new_content.is_none());
    }

    #[test]
    fn test_history_diff_nonadjacent_snapshots() {
        let dir = setup_project(&[("a.tex", "v1")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list0 = history_list(r.clone(), 1, 0).unwrap();
        let init_id = list0[0].id.clone();

        fs::write(dir.path().join("a.tex"), "v2").unwrap();
        history_snapshot(r.clone(), "s1".into()).unwrap();

        fs::write(dir.path().join("a.tex"), "v3").unwrap();
        let snap3 = history_snapshot(r.clone(), "s2".into()).unwrap().unwrap();

        // Diff from init directly to s2 (skipping s1)
        let diffs = history_diff(r, init_id, snap3.id).unwrap();
        let d = diffs.iter().find(|d| d.file_path == "a.tex").unwrap();
        assert_eq!(d.old_content.as_deref(), Some("v1"));
        assert_eq!(d.new_content.as_deref(), Some("v3"));
    }

    #[test]
    fn test_history_add_duplicate_label_errors() {
        let dir = setup_project(&[("main.tex", "x")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let list = history_list(r.clone(), 1, 0).unwrap();
        let id = list[0].id.clone();

        history_add_label(r.clone(), id.clone(), "dup".into()).unwrap();
        // Adding same label again should error
        let result = history_add_label(r, id, "dup".into());
        assert!(result.is_err());
    }

    #[test]
    fn test_history_restore_creates_restore_commit() {
        let dir = setup_project(&[("main.tex", "original")]);
        let r = root(&dir);
        history_init(r.clone()).unwrap();

        let init_list = history_list(r.clone(), 1, 0).unwrap();
        let init_id = init_list[0].id.clone();

        fs::write(dir.path().join("main.tex"), "changed").unwrap();
        history_snapshot(r.clone(), "change".into()).unwrap();

        history_restore(r.clone(), init_id).unwrap();

        // Should now have 4 entries: init, change, restore
        let list = history_list(r, 10, 0).unwrap();
        assert_eq!(list.len(), 3);
        assert!(list.iter().any(|s| s.message.contains("[restore]")));
    }
}
