<p align="center">
  <img src="./apps/desktop/src-tauri/icons/icon.png" width="120" height="120" alt="LocalPrism" />
</p>

<h1 align="center">LocalPrism</h1>

<p align="center">
  本地优先的学术写作桌面应用，面向论文、学位论文和推荐信。<br/>
  隔离的 Claude 目录 · 开箱即用的科研技能包 · 哈工大 / 哈工深模板。
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="./assets/demo/main.webp" alt="LocalPrism 工作区" width="800" />
</p>

<p align="center">
  <a href="https://github.com/boshuaiYu/LocalPrism">GitHub</a> ·
  <a href="https://github.com/boshuaiYu/LocalPrism/releases/latest/download/LocalPrism-macOS.dmg">macOS (Apple Silicon)</a> ·
  <a href="https://github.com/boshuaiYu/LocalPrism/releases/latest/download/LocalPrism-macOS-Intel.dmg">macOS (Intel)</a> ·
  <a href="https://github.com/boshuaiYu/LocalPrism/releases/latest/download/LocalPrism-Windows-setup.exe">Windows</a> ·
  <a href="https://github.com/boshuaiYu/LocalPrism/releases/latest/download/LocalPrism-Linux.AppImage">Linux</a> ·
  <a href="https://github.com/boshuaiYu/LocalPrism/releases">所有版本</a>
</p>

---

## 为什么是 LocalPrism？

LocalPrism 是一个**独立**的桌面应用：稿件留在本机文件夹，Tectonic 离线编译，AI 按需使用。它**借鉴了** [ClaudePrism](https://github.com/delibae/claude-prism) 的本地编辑器、PDF 预览和对话壳层，但围绕学术写作重做了运行时和模板，而不是换个名字继续做别人的 fork。

| | 云端 Prism 类工具 | LocalPrism |
|---|:---:|:---:|
| 文件 | 上传到厂商 | **只在项目目录里** |
| Claude 配置 | 共用 `~/.claude` | **独立的 `{LOCALPRISM_HOME}/claude-home`** |
| 首次技能 | 自己逛目录 | **PaperSpine + 学术 / Nature / 科学实验包** |
| 智能体 | 手改文件 | **设置里创建，并勾选技能** |
| 院校模板 | 通用空壳 | **哈工大推荐信、哈工深海报、`hitszthesis`** |
| 运行时 | 单一厂商 | **Claude，设置里可选 Codex** |

使用 AI 时，提示词和模型读到的文件仍会发给对应 API，稿件本身不会被拿去云端存档。使用 Claude 时请参阅 [数据使用说明](https://code.claude.com/docs/en/data-usage)。

---

## LocalPrism 多做了什么

### 隔离的主目录，不污染你的 Claude Code

技能、自定义 Agent、斜杠命令写在 LocalPrism 自己的数据根下（`claude-home/`）：安装目录可写就跟安装包放在一起，否则落在 `%APPDATA%/LocalPrism` 或系统配置目录。某一篇论文还可以把文件放在项目里的 `.localprism/`。日常使用的 `~/.claude` 不会被改乱。

[uv](https://docs.astral.sh/uv/) 管的 Python 环境同样装在 LocalPrism 主目录里。

<p align="center">
  <img src="./assets/demo/python.webp" alt="Python 环境" width="600" />
</p>

### 第一次打开就装好的科研技能包

首次启动可以把下面四个包装到**用户范围**（不会塞进当前论文）：

| 技能包 | 用途 |
|------|------|
| [PaperSpine](https://github.com/WUBING2023/PaperSpine) | 选题摄入、提纲、改写、引用、LaTeX 骨架 |
| [academic-research-skills](https://github.com/Imbad0202/academic-research-skills) | 文献综述、同行评审、参考文献核查、研究流水线 |
| [nature-skills](https://github.com/Yuan1z0825/nature-skills) | Nature 风格润色、图、写作、引用 |
| [scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) | 领域实验：Scanpy、BioPython、RDKit 等 |

之后仍可再装其他包。技能包自带的官方斜杠命令会按上游名字安装，界面不会把每条技能介绍重复贴进输入框。

<p align="center">
  <img src="./assets/demo/scientific.webp" alt="技能包" width="700" />
</p>

### 自定义 Agent，并能指定技能

「设置 → Agents」里可以新建 Claude（以及 Codex）智能体，从已安装的包里勾选技能。勾选的技能会预加载到该 Agent；用户目录里的其他技能仍可被运行时发现。

### 哈工大 / 哈工深模板，以及可写的期刊初稿

模板库不只是空论文：

- **哈工大 / 哈工深推荐信**（哈尔滨校徽信头；深圳校区中英双语）
- **哈工深学术海报**（A0 / beamerposter）
- **哈工深学位论文**，使用官方 [`hitszthesis`](https://github.com/YangLaTeX/hitszthesis)
- **带正文的初稿**：arXiv、Elsevier、中文期刊（`ctexart`）

选模板、起名、拖入 PDF / BIB / 图片即可开写。

<p align="center">
  <img src="./assets/demo/starter.webp" alt="模板库" width="700" />
</p>

### 可选的第二运行时

设置里可以安装并登录 **Codex**，与 Claude 并列。对话、技能和 Agent 跟随你为该会话选择的运行时。

---

## 从 ClaudePrism 保留的部分

下面这些是 LocalPrism 仍然建立在其上的本地能力，不是云端工作区。

- **离线 LaTeX** — 内嵌 Tectonic，宏包首次下载后本地缓存
- **实时 PDF** — MuPDF + SyncTeX，点 PDF 跳回源码
- **截图提问** — `Ctrl+Shift+X` / `⌘⇧X` 把 PDF 选区钉到对话（`Ctrl+X` 仍是剪切）
- **Git 历史** — 快照在 `.claudeprism/history.git/`，可打标签、对比、恢复
- **建议改动** — 按块接受或拒绝（`⌘Y` / `⌘N`）
- **Zotero** — OAuth 文献库和插入引用
- **外部编辑器** — Cursor、VS Code、Zed、Sublime Text
- **深色 / 浅色主题**

<p align="center">
  <img src="./assets/demo/claudecommand.webp" alt="对话与斜杠命令" width="600" />
</p>

<p align="center">
  <img src="./assets/demo/history.webp" alt="历史与建议改动" width="700" />
</p>

<p align="center">
  <img src="./assets/demo/capture_ask.webp" alt="截图提问" width="700" />
</p>

<p align="center">
  <img src="./assets/demo/zotero.webp" alt="Zotero" width="300" />
</p>

---

## 安装

从 [GitHub Releases](https://github.com/boshuaiYu/LocalPrism/releases) 下载最新安装包。

macOS / Linux 包由 GitHub Actions 构建；Windows 也可以在本机执行 `pnpm build:desktop`。

## 贡献

开发环境、测试和打包见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 致谢

LocalPrism **不是**别人仓库的 GitHub fork。它是独立仓库：桌面壳层（编辑器、Tectonic、PDF、对话界面）**借鉴自 ClaudePrism**，隔离目录、默认学术技能包、Agent 选择器和哈工大 / 哈工深模板是本项目自己的部分。

- [ClaudePrism](https://github.com/delibae/claude-prism)，作者 [delibae](https://github.com/delibae)
- [Open Prism](https://github.com/assistant-ui/open-prism)，作者 [assistant-ui](https://github.com/assistant-ui)（ClaudePrism 的上游起点）

## 许可证

[MIT](./LICENSE)
