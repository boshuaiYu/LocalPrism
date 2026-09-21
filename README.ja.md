<p align="center">
  <img src="./apps/desktop/src-tauri/icons/icon.png" width="120" height="120" alt="LocalPrism" />
</p>

<h1 align="center">LocalPrism</h1>

<p align="center">
  論文・学位論文・推薦状向けの、ローカルファーストな執筆デスクトップ。<br/>
  隔離された Claude ホーム · 初回導入の研究スキルパック · HIT / HITSZ テンプレート。
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="./assets/demo/main.webp" alt="LocalPrism ワークスペース" width="800" />
</p>

<p align="center">
  <a href="https://github.com/boshuaiYu/LocalPrism">
    <img src="https://img.shields.io/badge/GitHub-boshuaiYu%2FLocalPrism-black?style=flat-square&logo=github&logoColor=white" alt="GitHub" />
  </a>&nbsp;
  <a href="https://github.com/boshuaiYu/LocalPrism/releases/latest/download/LocalPrism-macOS.dmg">
    <img src="https://img.shields.io/badge/Download-macOS_(Apple_Silicon)-black?style=for-the-badge&logo=apple&logoColor=white" alt="macOS (Apple Silicon) をダウンロード" />
  </a>&nbsp;
  <a href="https://github.com/boshuaiYu/LocalPrism/releases/latest/download/LocalPrism-macOS-Intel.dmg">
    <img src="https://img.shields.io/badge/Download-macOS_(Intel)-555555?style=for-the-badge&logo=apple&logoColor=white" alt="macOS (Intel) をダウンロード" />
  </a>&nbsp;
  <a href="https://github.com/boshuaiYu/LocalPrism/releases/latest/download/LocalPrism-Windows-setup.exe">
    <img src="https://img.shields.io/badge/Download-Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Windows 版をダウンロード" />
  </a>&nbsp;
  <a href="https://github.com/boshuaiYu/LocalPrism/releases/latest/download/LocalPrism-Linux.AppImage">
    <img src="https://img.shields.io/badge/Download-Linux_(AppImage)-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux 版をダウンロード" />
  </a>
</p>
<p align="center">
  <a href="https://github.com/boshuaiYu/LocalPrism/releases">
    <img src="https://img.shields.io/github/v/release/boshuaiYu/LocalPrism?style=flat-square&label=Latest%20Release&color=green" alt="Latest Release" />
  </a>
</p>

---

## なぜ LocalPrism なのか

LocalPrism は**独立した**デスクトップアプリです。原稿は手元のフォルダに置き、Tectonic でオフラインコンパイルし、AI は必要なときだけ使います。[ClaudePrism](https://github.com/delibae/claude-prism) のローカルエディタ・PDF プレビュー・チャット殻を**参考にしつつ**、学術執筆向けのランタイムとテンプレートを組み直しています。他人の fork を改名しただけではありません。

| | クラウド型 Prism | LocalPrism |
|---|:---:|:---:|
| ファイル | ベンダーへアップロード | **プロジェクトフォルダに残す** |
| Claude 設定 | 共有の `~/.claude` | **隔離された `{LOCALPRISM_HOME}/claude-home`** |
| 初回スキル | カタログを自分で探す | **PaperSpine + 学術 / Nature / 科学パック** |
| エージェント | 手書きファイル | **設定画面で作成し、スキルを割り当て** |
| 大学テンプレ | 汎用の空原稿 | **HIT 推薦状、HITSZ ポスター、`hitszthesis`** |
| ランタイム | 単一ベンダー | **Claude。設定で Codex も選択可** |

AI 利用時はプロンプトとモデルが読んだファイルが API に送られます。原稿そのものをクラウド保存するためではありません。Claude 利用時は [データ使用](https://code.claude.com/docs/en/data-usage) を参照してください。

---

## LocalPrism が足したこと

### 共有 Claude プロファイルを汚さないホーム

スキル、カスタムエージェント、スラッシュコマンドは LocalPrism 自身のデータ根（`claude-home/`）に置きます。インストール先が書き込み可能なら実行ファイルの隣、そうでなければ `%APPDATA%/LocalPrism` や OS の設定ディレクトリです。論文ごとに `.localprism/` も使えます。普段の Claude Code プロファイルはそのままです。

[uv](https://docs.astral.sh/uv/) の Python も LocalPrism ホーム配下に入ります。

<p align="center">
  <img src="./assets/demo/python.webp" alt="Python 環境" width="600" />
</p>

### 初回起動で入る研究スキルパック

初回は次の 4 パックを**ユーザー範囲**へ入れられます（今開いている論文には入れません）。

| パック | 用途 |
|------|------|
| [PaperSpine](https://github.com/WUBING2023/PaperSpine) | 取り込み、アウトライン、改稿、引用、LaTeX 骨格 |
| [academic-research-skills](https://github.com/Imbad0202/academic-research-skills) | 文献レビュー、査読、参考文献チェック、研究パイプライン |
| [nature-skills](https://github.com/Yuan1z0825/nature-skills) | Nature 調の推敲、図、執筆、引用 |
| [scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) | Scanpy、BioPython、RDKit などの領域ラボ |

追加パックも後から入れられます。公式スラッシュ名は上流のまま。スキル紹介文を入力欄へ繰り返し貼ることはしません。

<p align="center">
  <img src="./assets/demo/scientific.webp" alt="スキルパック" width="700" />
</p>

### スキルを割り当てるカスタムエージェント

設定 → Agents で Claude（および Codex）エージェントを作り、導入済みパックからスキルを付けられます。割り当てたスキルはそのエージェントにプリロードされます。

### HIT / HITSZ と中身のある投稿用テンプレ

ギャラリーは空の論文だけではありません。

- **HIT / HITSZ 推薦状**（ハルビン校レターヘッド、深圳校の日英併記相当）
- **HITSZ 学術ポスター**（A0 / beamerposter）
- 公式 [`hitszthesis`](https://github.com/YangLaTeX/hitszthesis) の**学位論文**
- **本文入りの初稿**：arXiv、Elsevier、中国語ジャーナル（`ctexart`）

テンプレを選び、名前を付け、PDF / BIB / 図をドロップして書き始めます。

<p align="center">
  <img src="./assets/demo/starter.webp" alt="テンプレートギャラリー" width="700" />
</p>

### 任意の第二ランタイム

設定から **Codex** をインストールしてログインできます。会話・スキル・エージェントは、その会話で選んだランタイムに従います。

---

## ClaudePrism から残したもの

ローカルの編集基盤です。クラウドワークスペースではありません。

- **オフライン LaTeX** — 内蔵 Tectonic、初回ダウンロード後はキャッシュ
- **ライブ PDF** — MuPDF + SyncTeX
- **キャプチャして質問** — `Ctrl+Shift+X` / `⌘⇧X`（`Ctrl+X` は切り取りのまま）
- **Git 履歴** — `.claudeprism/history.git/`
- **提案差分** — チャンク単位で採用 / 却下（`⌘Y` / `⌘N`）
- **Zotero** — OAuth と引用挿入
- **外部エディタ** — Cursor、VS Code、Zed、Sublime Text
- **ダーク / ライト**

<p align="center">
  <img src="./assets/demo/claudecommand.webp" alt="チャットとスラッシュコマンド" width="600" />
</p>

<p align="center">
  <img src="./assets/demo/history.webp" alt="履歴と提案変更" width="700" />
</p>

<p align="center">
  <img src="./assets/demo/capture_ask.webp" alt="キャプチャして質問" width="700" />
</p>

<p align="center">
  <img src="./assets/demo/zotero.webp" alt="Zotero" width="300" />
</p>

---

## インストール

[GitHub Releases](https://github.com/boshuaiYu/LocalPrism/releases) から最新ビルドを入手してください。

macOS / Linux は GitHub Actions、Windows は `pnpm build:desktop` でも構築できます。

## コントリビュート

セットアップとテストは [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

## 謝辞

LocalPrism は**他人リポジトリの fork ではありません**。エディタ、Tectonic、PDF、チャット殻は [ClaudePrism](https://github.com/delibae/claude-prism) を参考にし、隔離ホーム、既定の学術パック、エージェント、HIT / HITSZ テンプレートは本プロジェクト側の追加です。

- [ClaudePrism](https://github.com/delibae/claude-prism)（[delibae](https://github.com/delibae)）
- [Open Prism](https://github.com/assistant-ui/open-prism)（[assistant-ui](https://github.com/assistant-ui)、ClaudePrism の起点）

## ライセンス

[MIT](./LICENSE)
