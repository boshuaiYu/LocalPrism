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
Because the checkbox never named these directories, checking it removed nothing the user could see.
`RMDir "$INSTDIR"` also only removes an empty install directory, so a writable install folder that still held `claude-home` stayed on disk after the binaries were removed.

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

Inside the install directory only these app-owned entries are removed: `claude-home`, `providers`, `uv`, `skills`, `.skills`, `agents`, `.agents`, `slash`, and `.localprism-writable`. The install directory itself is removed only when it is then empty. Other files next to the executable are kept.

Not removed:

- `%USERPROFILE%\Documents\LocalPrism`
- Project folders the user opened elsewhere, including a paper's `.localprism` directory
- `LOCALPRISM_HOME` when it points outside AppData and outside the install directory

The MSI package has no "delete application data" checkbox. Uninstalling the MSI removes the installed binaries and its own registration only. It does not remove the directories listed above. Use the NSIS uninstaller and the checkbox to delete application data.

## 中文

不勾选「Delete application data」（以及设置里的静默卸载）只删除程序文件、指向本次安装的快捷方式和卸载注册表项，不删除应用数据，也不删除用户的 LaTeX 项目。

勾选后会删除当前用户的：

- `%APPDATA%\LocalPrism`、`%LOCALAPPDATA%\LocalPrism`
- `%APPDATA%\ClaudePrism`、`%LOCALAPPDATA%\ClaudePrism`（旧名称下的登录信息）
- `%APPDATA%\com.claude-prism.desktop`、`%LOCALAPPDATA%\com.claude-prism.desktop`（Tauri / WebView2）
- 安装目录里的 `claude-home`、`providers`、`uv` 以及迁移前的 `skills` / `agents` / `slash`

不会删除「文档\LocalPrism」、用户自行打开的论文目录，以及安装目录里除此之外的其他文件。
