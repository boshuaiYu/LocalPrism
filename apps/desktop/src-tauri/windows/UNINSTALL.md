# Windows uninstall

NSIS setup (`LocalPrism_*_setup.exe`) shows **Delete application data**.
Tauri's default checkbox deletes `%APPDATA%\com.claude-prism.desktop` and `%LOCALAPPDATA%\com.claude-prism.desktop`. Those folders are the WebView2 profile for bundle id `com.claude-prism.desktop`, which is still used by the separate ClaudePrism 1.3.0 product. `windows/installer.nsi` is the Tauri 2.11.1 template with those two deletions removed.

LocalPrism stores its own data under `localprism_home()`:

1. The install directory, when that directory is writable (for example `D:\LocalPrism`).
2. Otherwise `%APPDATA%\LocalPrism` (`dirs::config_dir()` on Windows).

`windows/hooks.nsh` runs from `NSIS_HOOK_POSTUNINSTALL` after Tauri removes this install's binaries, shortcuts, and uninstall key.

## Without the checkbox (including silent `/S` and passive `/P`)

Removed: installed binaries, Start Menu and desktop shortcuts that point at this install, and `Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalPrism`.

Left in place: `%APPDATA%\LocalPrism`, `%LOCALAPPDATA%\LocalPrism`, and app-owned folders inside the install directory. Also left in place, always:

- `%APPDATA%\ClaudePrism` and `%LOCALAPPDATA%\ClaudePrism`
- `%APPDATA%\com.claude-prism.desktop` and `%LOCALAPPDATA%\com.claude-prism.desktop`
- The separate ClaudePrism 1.3.0 install (for example `D:\codexprism\ClaudePrism`), its uninstall registry entry, and `ClaudePrism.lnk`
- User papers, including `%USERPROFILE%\Documents\LocalPrism` and any project folder outside app data
- `LOCALPRISM_HOME` when it is neither AppData nor the install directory

Windows Settings often starts the uninstaller with `/S` or `/P` and skips the confirm page, so LocalPrism application data is kept. To delete it, run `uninstall.exe` from the LocalPrism install folder and check the box.

## With the checkbox, and not an in-place update

Also removed:

- `%APPDATA%\LocalPrism` and `%LOCALAPPDATA%\LocalPrism`, unless that path is the install directory itself (then only the named entries below are removed)
- Inside this install directory only: `claude-home`, `providers`, `uv`, `skills`, `.skills`, `agents`, `.agents`, `slash`, `skills-manifest.json`, and `.localprism-writable`
- The install directory itself, only when it is then empty

Not removed: the ClaudePrism paths and user project folders listed above. Other files next to `LocalPrism.exe` are kept.

The MSI package has no checkbox. Uninstalling it removes the installed binaries and its own registration only.

## 中文

不勾选时只删除 LocalPrism 的程序文件、指向本次安装的快捷方式和卸载注册表项。

勾选后额外删除当前用户的 `%APPDATA%\LocalPrism`、`%LOCALAPPDATA%\LocalPrism`，以及当前安装目录（例如 `D:\LocalPrism`）里的 `claude-home`、`providers`、`uv` 和迁移前留在安装目录根上的 `skills` / `agents` / `slash`。安装目录只有在随后为空时才删除。

即使勾选，也不删除 `%APPDATA%\ClaudePrism`、`%LOCALAPPDATA%\com.claude-prism.desktop`（WebView2）、另一套 ClaudePrism 1.3.0（例如 `D:\codexprism\ClaudePrism` 及其快捷方式），以及「文档\LocalPrism」和用户打开的论文目录。
