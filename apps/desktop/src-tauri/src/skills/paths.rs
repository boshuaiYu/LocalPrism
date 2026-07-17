use crate::runtime::RuntimeKind;
use crate::skills::domain::{SkillScope, SkillTarget};
use std::fmt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillPathError {
    HomeDirectoryUnavailable,
    ProjectPathRequired,
    ProjectPathMustBeAbsolute,
    InvalidFolder(String),
    PathResolution { path: PathBuf, message: String },
    OutsideRoot { root: PathBuf, destination: PathBuf },
}

impl fmt::Display for SkillPathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HomeDirectoryUnavailable => {
                write!(formatter, "Unable to resolve the user home directory")
            }
            Self::ProjectPathRequired => {
                write!(formatter, "Project-scoped skills require a project path")
            }
            Self::ProjectPathMustBeAbsolute => {
                write!(
                    formatter,
                    "Project-scoped skills require an absolute project path"
                )
            }
            Self::InvalidFolder(folder) => {
                write!(formatter, "Invalid skill folder name: {folder:?}")
            }
            Self::PathResolution { path, message } => {
                write!(formatter, "Failed to resolve {}: {message}", path.display())
            }
            Self::OutsideRoot { root, destination } => write!(
                formatter,
                "Skill destination {} is outside the selected root {}",
                destination.display(),
                root.display()
            ),
        }
    }
}

impl std::error::Error for SkillPathError {}

pub fn resolve_skill_root(
    runtime: RuntimeKind,
    scope: SkillScope,
    project_path: Option<&Path>,
) -> Result<PathBuf, SkillPathError> {
    let home_dir = if scope == SkillScope::User {
        dirs::home_dir()
    } else {
        None
    };
    resolve_skill_root_with_home(
        home_dir.as_deref(),
        project_path,
        SkillTarget { runtime, scope },
    )
}

pub(super) fn resolve_skill_root_with_home(
    home_dir: Option<&Path>,
    project_path: Option<&Path>,
    target: SkillTarget,
) -> Result<PathBuf, SkillPathError> {
    let base = match target.scope {
        SkillScope::User => home_dir.ok_or(SkillPathError::HomeDirectoryUnavailable)?,
        SkillScope::Project => {
            let project = project_path.ok_or(SkillPathError::ProjectPathRequired)?;
            if !project.is_absolute() {
                return Err(SkillPathError::ProjectPathMustBeAbsolute);
            }
            project
        }
    };

    let runtime_dir = match target.runtime {
        RuntimeKind::Claude => ".claude",
        RuntimeKind::Codex => ".agents",
    };
    Ok(base.join(runtime_dir).join("skills"))
}

pub fn skill_destination(root: &Path, folder: &str) -> Result<PathBuf, SkillPathError> {
    validate_skill_slug(folder)?;
    let destination = root.join(folder);

    match std::fs::symlink_metadata(&destination) {
        Ok(_) => ensure_canonical_skill_containment(root, &destination)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(SkillPathError::PathResolution {
                path: destination,
                message: error.to_string(),
            });
        }
    }

    Ok(destination)
}

pub fn ensure_canonical_skill_containment(
    root: &Path,
    destination: &Path,
) -> Result<(), SkillPathError> {
    let canonical_root = canonicalize(root)?;
    let canonical_destination = canonicalize(destination)?;
    if canonical_destination.starts_with(&canonical_root) {
        Ok(())
    } else {
        Err(SkillPathError::OutsideRoot {
            root: canonical_root,
            destination: canonical_destination,
        })
    }
}

fn canonicalize(path: &Path) -> Result<PathBuf, SkillPathError> {
    path.canonicalize()
        .map_err(|error| SkillPathError::PathResolution {
            path: path.to_path_buf(),
            message: error.to_string(),
        })
}

pub fn validate_skill_slug(folder: &str) -> Result<(), SkillPathError> {
    let is_drive_path = folder.as_bytes().get(1) == Some(&b':');
    if folder.is_empty()
        || folder == "."
        || folder == ".."
        || folder.contains(['/', '\\'])
        || folder.contains('\0')
        || is_drive_path
        || Path::new(folder).is_absolute()
    {
        return Err(SkillPathError::InvalidFolder(folder.to_string()));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_canonical_skill_containment, resolve_skill_root, resolve_skill_root_with_home,
        skill_destination, validate_skill_slug, SkillPathError,
    };
    use crate::runtime::RuntimeKind;
    use crate::skills::domain::{SkillScope, SkillTarget};
    use std::path::Path;

    fn target(runtime: RuntimeKind, scope: SkillScope) -> SkillTarget {
        SkillTarget { runtime, scope }
    }

    #[test]
    fn resolves_all_runtime_and_scope_roots() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let project = temp.path().join("project");

        assert_eq!(
            resolve_skill_root_with_home(
                Some(&home),
                None,
                target(RuntimeKind::Claude, SkillScope::User)
            )
            .unwrap(),
            home.join(".claude").join("skills")
        );
        assert_eq!(
            resolve_skill_root_with_home(
                Some(&home),
                None,
                target(RuntimeKind::Codex, SkillScope::User)
            )
            .unwrap(),
            home.join(".agents").join("skills")
        );
        assert_eq!(
            resolve_skill_root_with_home(
                None,
                Some(&project),
                target(RuntimeKind::Claude, SkillScope::Project)
            )
            .unwrap(),
            project.join(".claude").join("skills")
        );
        assert_eq!(
            resolve_skill_root_with_home(
                None,
                Some(&project),
                target(RuntimeKind::Codex, SkillScope::Project)
            )
            .unwrap(),
            project.join(".agents").join("skills")
        );
    }

    #[test]
    fn project_scope_requires_an_explicit_project_path() {
        let temp = tempfile::tempdir().unwrap();
        let error = resolve_skill_root_with_home(
            Some(temp.path()),
            None,
            target(RuntimeKind::Claude, SkillScope::Project),
        )
        .unwrap_err();

        assert_eq!(error, SkillPathError::ProjectPathRequired);

        let public_error =
            resolve_skill_root(RuntimeKind::Claude, SkillScope::Project, None).unwrap_err();
        assert_eq!(public_error, SkillPathError::ProjectPathRequired);
    }

    #[test]
    fn project_scope_rejects_relative_paths_instead_of_using_the_current_directory() {
        for project in [Path::new(""), Path::new("relative-project")] {
            let error = resolve_skill_root_with_home(
                None,
                Some(project),
                target(RuntimeKind::Codex, SkillScope::Project),
            )
            .unwrap_err();

            assert_eq!(error, SkillPathError::ProjectPathMustBeAbsolute);
        }
    }

    #[test]
    fn user_scope_requires_an_explicit_home_path() {
        let error = resolve_skill_root_with_home(
            None,
            Some(Path::new("unused-project")),
            target(RuntimeKind::Codex, SkillScope::User),
        )
        .unwrap_err();

        assert_eq!(error, SkillPathError::HomeDirectoryUnavailable);
    }

    #[test]
    fn rejects_traversal_absolute_and_nested_skill_folders() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        std::fs::create_dir_all(&root).unwrap();
        let absolute = temp.path().join("absolute").to_string_lossy().to_string();
        let invalid = [
            "",
            ".",
            "..",
            "../escape",
            r"..\escape",
            "nested/skill",
            r"nested\skill",
            &absolute,
        ];

        for folder in invalid {
            assert!(
                matches!(
                    skill_destination(&root, folder),
                    Err(SkillPathError::InvalidFolder(_))
                ),
                "folder should be rejected: {folder:?}"
            );
            assert!(matches!(
                validate_skill_slug(folder),
                Err(SkillPathError::InvalidFolder(_))
            ));
        }
    }

    #[test]
    fn public_root_and_slug_apis_match_the_runtime_scope_contract() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");

        assert_eq!(
            resolve_skill_root(RuntimeKind::Codex, SkillScope::Project, Some(&project)).unwrap(),
            project.join(".agents").join("skills")
        );
        assert_eq!(validate_skill_slug("valid-skill_01"), Ok(()));
    }

    #[test]
    fn rejects_a_canonical_destination_outside_the_selected_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let error = ensure_canonical_skill_containment(&root, &outside).unwrap_err();
        assert!(matches!(error, SkillPathError::OutsideRoot { .. }));
    }

    #[test]
    fn accepts_existing_and_future_destinations_inside_the_selected_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let existing = root.join("existing");
        std::fs::create_dir_all(&existing).unwrap();

        assert_eq!(skill_destination(&root, "existing").unwrap(), existing);
        assert_eq!(
            skill_destination(&root, "future").unwrap(),
            root.join("future")
        );
    }

    #[test]
    fn rejects_a_symlink_or_junction_that_escapes_the_selected_root() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("skills");
        let outside = temp.path().join("outside");
        let link = root.join("escape");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        match create_directory_link(&outside, &link) {
            Ok(()) => {
                let error = skill_destination(&root, "escape").unwrap_err();
                assert!(matches!(error, SkillPathError::OutsideRoot { .. }));
            }
            Err(error) if link_creation_is_not_permitted(&error) => {
                // Windows can deny symlink creation without Developer Mode. Exercise the
                // same canonical containment seam rather than skipping the security check.
                let error = ensure_canonical_skill_containment(&root, &outside).unwrap_err();
                assert!(matches!(error, SkillPathError::OutsideRoot { .. }));
            }
            Err(error) => panic!("failed to create test directory link: {error}"),
        }
    }

    #[cfg(unix)]
    fn create_directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[cfg(unix)]
    fn link_creation_is_not_permitted(error: &std::io::Error) -> bool {
        error.kind() == std::io::ErrorKind::PermissionDenied
    }

    #[cfg(windows)]
    fn link_creation_is_not_permitted(error: &std::io::Error) -> bool {
        matches!(error.raw_os_error(), Some(5 | 1314))
    }
}
