//! Replace a running Linux AppImage without the updater's temp-dir walk.
//!
//! tauri-plugin-updater 2.10.1 `install_appimage` tries `/tmp`, then the
//! cache directory, then the AppImage's parent. `tempdir_in(... )?` and
//! `rename(... )?` return on the first error, so a later same-directory
//! location is never tried. Debian's `/tmp` is often another mount, and a
//! rename can still fail with EXDEV when `st_dev` matches. The AppImage
//! file is then left unchanged.
//!
//! The replacement is a sibling file in the AppImage directory, fsynced,
//! then renamed over the destination. That rename stays on the destination
//! mount. The mounted `/.mount_*` tree is the read-only payload, not the
//! file the user launched.

use std::ffi::OsStr;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppImageInstallPlan {
    /// `APPIMAGE` is unset. Windows, macOS, and dev builds keep the
    /// platform installer.
    NotAppImage,
    /// Write `bytes` over this AppImage path.
    Replace(PathBuf),
}

pub fn appimage_payload_is_raw(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && bytes.starts_with(b"\x7fELF")
}

/// Decide how a prepared download should be installed.
///
/// A set `APPIMAGE` must resolve to the real file. A payload that is not
/// a raw AppImage is an error: falling through to the plugin installer
/// is the path that leaves the file unchanged.
pub fn plan_appimage_install(
    appimage: Option<&OsStr>,
    bytes: &[u8],
) -> Result<AppImageInstallPlan, String> {
    let Some(raw) = appimage else {
        return Ok(AppImageInstallPlan::NotAppImage);
    };
    if raw.is_empty() || raw.to_string_lossy().trim().is_empty() {
        return Ok(AppImageInstallPlan::NotAppImage);
    }
    let target = appimage_install_target(raw)?;
    if !appimage_payload_is_raw(bytes) {
        return Err("Downloaded update is not a Linux AppImage executable.".to_string());
    }
    Ok(AppImageInstallPlan::Replace(target))
}

pub fn appimage_install_target(appimage: &OsStr) -> Result<PathBuf, String> {
    if appimage.is_empty() || appimage.to_string_lossy().trim().is_empty() {
        return Err("APPIMAGE is empty.".to_string());
    }
    let path = PathBuf::from(appimage);
    if !path.is_absolute() {
        return Err(format!(
            "APPIMAGE is not an absolute path: {}",
            path.display()
        ));
    }
    if path_is_appimage_mount(&path) {
        return Err(
            "APPIMAGE points at the mounted AppImage filesystem, not the AppImage file."
                .to_string(),
        );
    }
    if !path.is_file() {
        return Err(format!("AppImage file does not exist: {}", path.display()));
    }
    let canonical = path.canonicalize().map_err(|err| {
        format!(
            "Could not resolve the AppImage path {}: {err}",
            path.display()
        )
    })?;
    if path_is_appimage_mount(&canonical) {
        return Err(
            "APPIMAGE points at the mounted AppImage filesystem, not the AppImage file."
                .to_string(),
        );
    }
    Ok(canonical)
}

pub fn replace_appimage_file(destination: &Path, bytes: &[u8]) -> Result<(), String> {
    if path_is_appimage_mount(destination) {
        return Err("Refusing to write inside the mounted AppImage filesystem.".to_string());
    }
    if !appimage_payload_is_raw(bytes) {
        return Err("Downloaded update is not a Linux AppImage executable.".to_string());
    }
    let partial = appimage_partial_path(destination)?;
    let written = write_then_rename(destination, &partial, bytes);
    if written.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    written
}

fn appimage_partial_path(destination: &Path) -> Result<PathBuf, String> {
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| {
            format!(
                "AppImage has no parent directory: {}",
                destination.display()
            )
        })?;
    let name = destination
        .file_name()
        .ok_or_else(|| format!("AppImage path has no file name: {}", destination.display()))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    Ok(parent.join(format!(
        ".{}.{}.{nanos}.partial",
        name.to_string_lossy(),
        std::process::id()
    )))
}

fn write_then_rename(destination: &Path, partial: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(partial)
        .map_err(|err| {
            format!(
                "Could not create the AppImage update next to {}: {err}",
                destination.display()
            )
        })?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|err| {
            format!(
                "Could not write the AppImage update next to {}: {err}",
                destination.display()
            )
        })?;
    drop(file);
    copy_executable_mode(destination, partial)?;
    std::fs::rename(partial, destination).map_err(|err| {
        format!(
            "Could not replace the AppImage {}: {err}",
            destination.display()
        )
    })?;
    if let Some(parent) = destination.parent() {
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    Ok(())
}

fn copy_executable_mode(source: &Path, target: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(source)
            .map_err(|err| format!("Could not read AppImage permissions: {err}"))?
            .permissions()
            .mode()
            | 0o111;
        std::fs::set_permissions(target, std::fs::Permissions::from_mode(mode))
            .map_err(|err| format!("Could not mark the AppImage update executable: {err}"))?;
    }
    #[cfg(not(unix))]
    {
        let _ = (source, target);
    }
    Ok(())
}

fn path_is_appimage_mount(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name.to_string_lossy().starts_with(".mount_"),
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        appimage_install_target, appimage_partial_path, appimage_payload_is_raw,
        plan_appimage_install, replace_appimage_file, AppImageInstallPlan,
    };
    use std::ffi::OsStr;
    use std::fs;
    use std::path::{Path, PathBuf};

    const OLD: &[u8] = b"beta8-bytes";
    const NEW: &[u8] = b"\x7fELFbeta9-bytes";

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "localprism-appimage-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_nanos())
                    .unwrap_or(0)
            ));
            fs::create_dir_all(&dir).expect("scratch dir");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
            }
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write_appimage(dir: &Path, bytes: &[u8]) -> PathBuf {
        let path = dir.join("LocalPrism.AppImage");
        fs::write(&path, bytes).expect("write appimage");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("mode");
        }
        path
    }

    #[test]
    fn raw_appimage_is_an_elf_and_gzip_is_not() {
        assert!(appimage_payload_is_raw(b"\x7fELF\x02\x01"));
        assert!(!appimage_payload_is_raw(b"\x1f\x8b\x08"));
        assert!(!appimage_payload_is_raw(b"ELF"));
        assert!(!appimage_payload_is_raw(&[]));
    }

    #[test]
    fn blank_appimage_keeps_the_platform_installer() {
        assert_eq!(
            plan_appimage_install(None, NEW).expect("plan"),
            AppImageInstallPlan::NotAppImage
        );
        assert_eq!(
            plan_appimage_install(Some(OsStr::new("   ")), NEW).expect("blank"),
            AppImageInstallPlan::NotAppImage
        );
    }

    #[test]
    fn mounted_payload_and_relative_paths_are_rejected() {
        let scratch = Scratch::new();
        let mounted = scratch.path().join(".mount_LocalPrismabc");
        fs::create_dir_all(&mounted).expect("mount dir");
        let payload = mounted.join("LocalPrism.AppImage");
        fs::write(&payload, OLD).expect("payload");

        let err = plan_appimage_install(Some(payload.as_os_str()), NEW).expect_err("mount");
        assert!(err.contains("mounted AppImage filesystem"), "{err}");
        assert_eq!(fs::read(&payload).expect("unchanged"), OLD);

        let relative = plan_appimage_install(Some(OsStr::new("LocalPrism.AppImage")), NEW)
            .expect_err("relative");
        assert!(relative.contains("absolute"), "{relative}");
        assert!(appimage_install_target(OsStr::new("/tmp/.mount_LocalPrism/usr/bin/app")).is_err());
    }

    #[test]
    fn plan_replaces_an_existing_appimage_with_elf_bytes() {
        let scratch = Scratch::new();
        let path = write_appimage(scratch.path(), OLD);
        let plan = plan_appimage_install(Some(path.as_os_str()), NEW).expect("plan");
        let AppImageInstallPlan::Replace(target) = plan else {
            panic!("expected replace");
        };
        assert_eq!(target, path.canonicalize().expect("canonical"));

        let gzip =
            plan_appimage_install(Some(path.as_os_str()), b"\x1f\x8bnot-elf").expect_err("gzip");
        assert!(gzip.contains("not a Linux AppImage"), "{gzip}");
        assert_eq!(fs::read(&path).expect("untouched"), OLD);
    }

    #[test]
    fn partial_file_is_created_beside_the_appimage() {
        let scratch = Scratch::new();
        let path = write_appimage(scratch.path(), OLD);
        let partial = appimage_partial_path(&path).expect("partial");
        assert_eq!(partial.parent(), path.parent());
        assert!(partial
            .file_name()
            .expect("name")
            .to_string_lossy()
            .ends_with(".partial"));
    }

    #[test]
    fn replace_swaps_bytes_and_sets_the_executable_bit() {
        let scratch = Scratch::new();
        let path = write_appimage(scratch.path(), OLD);
        replace_appimage_file(&path, NEW).expect("replace");
        assert_eq!(fs::read(&path).expect("new bytes"), NEW);
        let entries = fs::read_dir(scratch.path())
            .expect("dir")
            .collect::<Result<Vec<_>, _>>()
            .expect("entries");
        assert_eq!(entries.len(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).expect("meta").permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "mode {mode:o}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn read_only_directory_leaves_the_original_appimage_unchanged() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = Scratch::new();
        let path = write_appimage(scratch.path(), OLD);
        fs::set_permissions(scratch.path(), fs::Permissions::from_mode(0o555)).expect("readonly");
        let err = replace_appimage_file(&path, NEW).expect_err("readonly");
        fs::set_permissions(scratch.path(), fs::Permissions::from_mode(0o755)).expect("restore");
        assert!(
            err.contains("Could not create the AppImage update"),
            "{err}"
        );
        assert_eq!(fs::read(&path).expect("original"), OLD);
        let names = fs::read_dir(scratch.path())
            .expect("dir")
            .map(|entry| entry.expect("entry").file_name())
            .collect::<Vec<_>>();
        assert_eq!(names, vec![path.file_name().expect("name").to_os_string()]);
    }
}
