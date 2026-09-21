<p align="center">
  <img src="./apps/desktop/src-tauri/icons/icon.png" width="120" height="120" alt="LocalPrism" />
</p>

<h1 align="center">LocalPrism</h1>

<p align="center">
  A local-first academic writing desktop for papers, theses, and letters.<br/>
  Isolated Claude home · first-run research skill packs · HIT / HITSZ templates.
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="./assets/demo/main.webp" alt="LocalPrism workspace" width="800" />
</p>

<p align="center">
  <a href="https://github.com/boshuaiYu/LocalPrism">
    <img src="https://img.shields.io/badge/GitHub-boshuaiYu%2FLocalPrism-black?style=flat-square&logo=github&logoColor=white" alt="GitHub" />
  </a>&nbsp;
  <a href="https://github.com/boshuaiYu/LocalPrism/releases/latest/download/LocalPrism-macOS.dmg">
    <img src="https://img.shields.io/badge/Download-macOS_(Apple_Silicon)-black?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS (Apple Silicon)" />
  </a>&nbsp;
  <a href="https://github.com/boshuaiYu/LocalPrism/releases/latest/download/LocalPrism-macOS-Intel.dmg">
    <img src="https://img.shields.io/badge/Download-macOS_(Intel)-555555?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS (Intel)" />
  </a>&nbsp;
  <a href="https://github.com/boshuaiYu/LocalPrism/releases/latest/download/LocalPrism-Windows-setup.exe">
    <img src="https://img.shields.io/badge/Download-Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows" />
  </a>&nbsp;
  <a href="https://github.com/boshuaiYu/LocalPrism/releases/latest/download/LocalPrism-Linux.AppImage">
    <img src="https://img.shields.io/badge/Download-Linux_(AppImage)-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Download for Linux" />
  </a>
</p>
<p align="center">
  <a href="https://github.com/boshuaiYu/LocalPrism/releases">
    <img src="https://img.shields.io/github/v/release/boshuaiYu/LocalPrism?style=flat-square&label=Latest%20Release&color=green" alt="Latest Release" />
  </a>
</p>

---

## Why LocalPrism?

LocalPrism is an **independent** desktop app for writing on your own machine: LaTeX stays on disk, Tectonic compiles offline, and AI is optional. It is **inspired by** [ClaudePrism](https://github.com/delibae/claude-prism) — same local-first editor, preview, and Claude chat shell — then rebuilt around academic workflows that ClaudePrism does not ship.

| | Cloud Prism-style tools | LocalPrism |
|---|:---:|:---:|
| Files | Uploaded to a vendor | **Stay in the project folder** |
| Claude config | Shared `~/.claude` | **Isolated `{LOCALPRISM_HOME}/claude-home`** |
| First-run skills | Browse a catalog | **PaperSpine + academic / Nature / scientific packs** |
| Agents | Manual files | **Settings editor with a skill picker** |
| Campus templates | Generic starters | **HIT letters, HITSZ poster, `hitszthesis`** |
| Runtime | One vendor | **Claude, with optional Codex in Settings** |

AI features still send prompts and the files the model reads to the provider API. Documents are not uploaded for cloud storage. See [Claude Code data usage](https://code.claude.com/docs/en/data-usage) when you use Claude.

---

## What LocalPrism adds

### Isolated home, not a shared Claude profile

Skills, custom agents, and slash commands live under LocalPrism’s own data root (`claude-home/`), next to the app when the install folder is writable, or under `%APPDATA%/LocalPrism` / the platform config dir. A paper can also keep project-only files in `.localprism/`. Your everyday Claude Code profile is left alone.

Python via [uv](https://docs.astral.sh/uv/) is likewise installed under LocalPrism’s home, not mixed into a random global toolchain.

<p align="center">
  <img src="./assets/demo/python.webp" alt="Python environment" width="600" />
</p>

### First-run research skill packs

On first launch LocalPrism can install four default packs into user scope (not into the current paper):

| Pack | What it is for |
|------|----------------|
| [PaperSpine](https://github.com/WUBING2023/PaperSpine) | Paper intake, outline, rewrite, citation, and LaTeX spine |
| [academic-research-skills](https://github.com/Imbad0202/academic-research-skills) | Literature review, peer review, reference checking, research pipeline |
| [nature-skills](https://github.com/Yuan1z0825/nature-skills) | Nature-style polishing, figures, writing, citations |
| [scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) | Domain labs: Scanpy, BioPython, RDKit, and related scientific tools |

You can still browse and add more packs, including the broader scientific catalog. Official slash names from a pack stay official — the UI does not paste every skill blurb into the composer.

<p align="center">
  <img src="./assets/demo/scientific.webp" alt="Skill packs" width="700" />
</p>

### Custom agents with assigned skills

Settings → Agents lets you create Claude (and Codex) agents and attach skills from the installed packs. Assigned skills are preloaded for that agent; other user-scope skills remain discoverable.

### HIT / HITSZ and journal starters

The gallery is not only generic papers:

- **HIT / HITSZ recommendation letters** (Harbin letterhead; Shenzhen bilingual letterhead)
- **HITSZ academic poster** (A0 / beamerposter)
- **HITSZ thesis** using the official [`hitszthesis`](https://github.com/YangLaTeX/hitszthesis) class
- **Filled starters** for arXiv, Elsevier, and a Chinese journal article (`ctexart`)

Pick a template, name the project, drop PDF / BIB / figures, and write.

<p align="center">
  <img src="./assets/demo/starter.webp" alt="Template gallery" width="700" />
</p>

### Optional second runtime

Settings can install and sign in to **Codex** next to Claude. Chat, skills, and agents stay on the runtime you select for that conversation.

---

## What we kept (from ClaudePrism)

These are the parts LocalPrism still builds on — the local editor, not a cloud workspace.

- **Offline LaTeX** — embedded Tectonic, packages cached after first download
- **Live PDF** — MuPDF + SyncTeX; click the PDF to jump to source
- **Capture & Ask** — `Ctrl+Shift+X` / `⌘⇧X` pins a PDF crop into chat (`Ctrl+X` stays cut)
- **Git history** — snapshots in `.claudeprism/history.git/`, labels, diffs, restore
- **Proposed edits** — accept or reject Claude’s chunks (`⌘Y` / `⌘N`)
- **Zotero** — OAuth library and citation insert
- **External editors** — Cursor, VS Code, Zed, Sublime Text
- **Dark / light theme**

<p align="center">
  <img src="./assets/demo/claudecommand.webp" alt="Chat and slash commands" width="600" />
</p>

<p align="center">
  <img src="./assets/demo/history.webp" alt="History and proposed changes" width="700" />
</p>

<p align="center">
  <img src="./assets/demo/capture_ask.webp" alt="Capture and ask" width="700" />
</p>

<p align="center">
  <img src="./assets/demo/zotero.webp" alt="Zotero" width="300" />
</p>

---

## Installation

Download the latest build from [GitHub Releases](https://github.com/boshuaiYu/LocalPrism/releases).

macOS and Linux installers are produced by GitHub Actions; Windows can also be built locally with `pnpm build:desktop`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, tests, and the desktop build.

## Acknowledgments

LocalPrism is **not a GitHub fork**. It is a separate repository that **borrows the ClaudePrism desktop shell** — editor, Tectonic, PDF preview, chat chrome — and then adds the isolated home, default academic packs, agents, and HIT / HITSZ templates described above.

- [ClaudePrism](https://github.com/delibae/claude-prism) by [delibae](https://github.com/delibae)
- [Open Prism](https://github.com/assistant-ui/open-prism) by [assistant-ui](https://github.com/assistant-ui), which ClaudePrism itself started from

## License

[MIT](./LICENSE)
