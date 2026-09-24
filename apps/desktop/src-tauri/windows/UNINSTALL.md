# Windows uninstall

NSIS setup (`LocalPrism_*_setup.exe`) is the installer that shows **Delete application data**.
The checkbox label comes from Tauri (`deleteAppData`). Checking it used to delete only:

- `%APPDATA%\com.claude-prism.desktop`
- `%LOCALAPPDATA%\com.claude-prism.desktop`

Those folders are the Tauri / WebView2 profile for bundle id `com.claude-prism.desktop`.
LocalPrism itself stores skills, providers, and the uv/Python toolchain under `localprism_home()`:

1. The install directory, when that directory is writable (for example `D:\LocalPrism`).
2. Otherwise `%APPDATA%\LocalPrism` (`dirs::config_dir()` on Windows).

`%APPDATA%\ClaudePrism` is the pre-rename auth folder (`anthropic-auth.json`).
`$INSTDIR\ClaudePrism` is only the legacy skills-manifest directory inside this install.
A writable custom directory such as `D:\LocalPrism` is the app home, so `claude-home`, `providers`, and `uv` sit next to `LocalPrism.exe`. Tauri's `RMDir "$INSTDIR"` does not remove that non-empty folder.

Checking the box used to remove none of those paths. On a machine that also has the older ClaudePrism 1.3.0 registration (`D:\codexprism\ClaudePrism`, Start Menu `ClaudePrism.lnk`), that other install is a different product. This uninstaller does not delete that directory, its uninstall registry key, or a shortcut that points at it.

`windows/hooks.nsh` runs from `NSIS_HOOK_POSTUNINSTALL` after Tauri's own file and registry removal.

## Without the checkbox (including silent `/S` and passive `/P`)

Tauri removes the installed binaries, Start Menu and desktop shortcuts that point at this install, and the Apps & Features uninstall key `Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalPrism`.

Left in place:

- `%APPDATA%\LocalPrism` and `%LOCALAPPDATA%\LocalPrism`
- `%APPDATA%\ClaudePrism` and `%LOCALAPPDATA%\ClaudePrism`
- `%APPDATA%\com.claude-prism.desktop` and `%LOCALAPPDATA%\com.claude-prism.desktop` (WebView2)
- App-owned folders inside a writable install directory (`claude-home`, `providers`, `uv`, and the legacy `skills` / `agents` / `slash` directories)
- User papers, including `%USERPROFILE%\Documents\LocalPrism` and any project folder outside app data
- A `LOCALPRISM_HOME` directory that is neither AppData nor the install directory

Windows Settings often starts the uninstaller with `/S` or `/P`. Those modes skip the confirm page, so application data is kept. To delete it, run `uninstall.exe` from the install folder and check the box.

## With the checkbox, and not an in-place update

Everything in the "without" list of app-data paths is removed, plus Tauri's bundle-id folders above.

Inside the install directory only these app-owned entries are removed: `claude-home`, `providers`, `uv`, `skills`, `.skills`, `agents`, `.agents`, `slash`, `ClaudePrism` (legacy manifest), `skills-manifest.json`, and `.localprism-writable`. The install directory itself is removed only when it is then empty. Other files next to the executable are kept.

A `ClaudePrism.lnk` shortcut is removed only when its target is this install's `LocalPrism.exe` or `ClaudePrism.exe`. The shortcut for a still-registered ClaudePrism install on another path is left in place.

Not removed:

- `%USERPROFILE%\Documents\LocalPrism`
- Project folders the user opened elsewhere, including a paper's `.localprism` directory
- `LOCALPRISM_HOME` when it points outside AppData and outside the install directory

The MSI package has no "delete application data" checkbox. Uninstalling the MSI removes the installed binaries and its own registration only. It does not remove the directories listed above. Use the NSIS uninstaller and the checkbox to delete application data.

## 中文

不勾选「Delete application data」（以及设置里的静默卸载）只删除程序文件、指向本次安装的快捷方式和卸载注册表项，不删除应用数据，也不删除用户的 LaTeX 项目。

勾选后会删除当前用户的：

- `%APPDATA%\LocalPrism`、`%LOCALAPPDATA%\LocalPrism`
- `%APPDATA%\ClaudePrism`、`%LOCALAPPDATA%\ClaudePrism`（本程序写过的旧登录信息）
- `%APPDATA%\com.claude-prism.desktop`、`%LOCALAPPDATA%\com.claude-prism.desktop`（Tauri / WebView2）
- 当前安装目录（例如 `D:\LocalPrism`）里的 `claude-home`、`providers`、`uv`、迁移前的 `skills` / `agents` / `slash`、`ClaudePrism`（旧技能清单）、`skills-manifest.json`

不会删除「文档\LocalPrism」、用户自行打开的论文目录、安装目录里除此之外的其他文件，也不会卸载另一套仍在注册表里的 ClaudePrism（例如 `D:\codexprism\ClaudePrism` 及其开始菜单快捷方式）。那套程序要用它自己的 `uninstall.exe`。
