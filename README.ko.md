<p align="center">
  <img src="./apps/desktop/src-tauri/icons/icon.png" width="120" height="120" alt="LocalPrism" />
</p>

<h1 align="center">LocalPrism</h1>

<p align="center">
  논문·학위논문·추천서를 위한 로컬 우선 작성 데스크톱.<br/>
  격리된 Claude 홈 · 첫 실행 연구 스킬 팩 · HIT / HITSZ 템플릿.
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="./assets/demo/main.webp" alt="LocalPrism 작업 공간" width="800" />
</p>

<p align="center">
  <a href="https://github.com/boshuaiYu/LocalPrism">
    <img src="https://img.shields.io/badge/GitHub-boshuaiYu%2FLocalPrism-black?style=flat-square&logo=github&logoColor=white" alt="GitHub" />
  </a>&nbsp;
  <a href="https://github.com/boshuaiYu/LocalPrism/releases/latest/download/LocalPrism-macOS.dmg">
    <img src="https://img.shields.io/badge/Download-macOS_(Apple_Silicon)-black?style=for-the-badge&logo=apple&logoColor=white" alt="macOS (Apple Silicon) 다운로드" />
  </a>&nbsp;
  <a href="https://github.com/boshuaiYu/LocalPrism/releases/latest/download/LocalPrism-macOS-Intel.dmg">
    <img src="https://img.shields.io/badge/Download-macOS_(Intel)-555555?style=for-the-badge&logo=apple&logoColor=white" alt="macOS (Intel) 다운로드" />
  </a>&nbsp;
  <a href="https://github.com/boshuaiYu/LocalPrism/releases/latest/download/LocalPrism-Windows-setup.exe">
    <img src="https://img.shields.io/badge/Download-Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Windows 다운로드" />
  </a>&nbsp;
  <a href="https://github.com/boshuaiYu/LocalPrism/releases/latest/download/LocalPrism-Linux.AppImage">
    <img src="https://img.shields.io/badge/Download-Linux_(AppImage)-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux 다운로드" />
  </a>
</p>
<p align="center">
  <a href="https://github.com/boshuaiYu/LocalPrism/releases">
    <img src="https://img.shields.io/github/v/release/boshuaiYu/LocalPrism?style=flat-square&label=Latest%20Release&color=green" alt="Latest Release" />
  </a>
</p>

---

## 왜 LocalPrism인가?

LocalPrism은 **독립** 데스크톱 앱입니다. 원고는 로컬 폴더에 두고 Tectonic으로 오프라인 컴파일하며, AI는 필요할 때만 씁니다. [ClaudePrism](https://github.com/delibae/claude-prism)의 로컬 편집기·PDF 미리보기·채팅 셸을 **참고**한 뒤, 학술 작성에 맞게 런타임과 템플릿을 다시 짠 것입니다. 남의 fork 이름만 바꾼 저장소가 아닙니다.

| | 클라우드형 Prism | LocalPrism |
|---|:---:|:---:|
| 파일 | 벤더에 업로드 | **프로젝트 폴더에 유지** |
| Claude 설정 | 공유 `~/.claude` | **격리된 `{LOCALPRISM_HOME}/claude-home`** |
| 첫 스킬 | 카탈로그를 직접 탐색 | **PaperSpine + 학술 / Nature / 과학 팩** |
| 에이전트 | 파일을 직접 작성 | **설정에서 만들고 스킬을 지정** |
| 캠퍼스 템플릿 | 빈 원고 | **HIT 추천서, HITSZ 포스터, `hitszthesis`** |
| 런타임 | 단일 벤더 | **Claude. 설정에서 Codex 선택 가능** |

AI를 쓰면 프롬프트와 모델이 읽은 파일은 API로 갑니다. 원고를 클라우드에 보관하려고 올리는 것은 아닙니다. Claude 사용 시 [데이터 사용](https://code.claude.com/docs/en/data-usage)을 확인하세요.

---

## LocalPrism이 더한 것

### 공유 Claude 프로필을 건드리지 않는 홈

스킬, 커스텀 에이전트, 슬래시 명령은 LocalPrism 데이터 루트(`claude-home/`)에 둡니다. 설치 폴더가 쓰기 가능하면 실행 파일 옆, 아니면 `%APPDATA%/LocalPrism` 또는 OS 설정 디렉터리입니다. 논문마다 `.localprism/`도 쓸 수 있습니다. 평소 Claude Code 프로필은 그대로입니다.

[uv](https://docs.astral.sh/uv/) Python도 LocalPrism 홈 아래에 설치됩니다.

<p align="center">
  <img src="./assets/demo/python.webp" alt="Python 환경" width="600" />
</p>

### 첫 실행에 들어가는 연구 스킬 팩

처음 실행하면 아래 네 팩을 **사용자 범위**에 넣을 수 있습니다(현재 논문 폴더에는 넣지 않음).

| 팩 | 용도 |
|------|------|
| [PaperSpine](https://github.com/WUBING2023/PaperSpine) | 수집, 개요, 개고, 인용, LaTeX 골격 |
| [academic-research-skills](https://github.com/Imbad0202/academic-research-skills) | 문헌 리뷰, 피어리뷰, 참고문헌 검증, 연구 파이프라인 |
| [nature-skills](https://github.com/Yuan1z0825/nature-skills) | Nature 스타일 윤문, 그림, 글쓰기, 인용 |
| [scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills) | Scanpy, BioPython, RDKit 등 도메인 랩 |

추가 팩은 나중에 더 설치할 수 있습니다. 공식 슬래시 이름은 업스트림을 유지하며, 스킬 소개문을 입력창에 반복해서 붙이지 않습니다.

<p align="center">
  <img src="./assets/demo/scientific.webp" alt="스킬 팩" width="700" />
</p>

### 스킬을 지정하는 커스텀 에이전트

설정 → Agents에서 Claude(및 Codex) 에이전트를 만들고 설치된 팩의 스킬을 붙일 수 있습니다. 지정한 스킬은 해당 에이전트에 미리 로드됩니다.

### HIT / HITSZ와 본문이 있는 투고용 초고

갤러리는 빈 논문만이 아닙니다.

- **HIT / HITSZ 추천서** (하얼빈 레터헤드, 선전 캠퍼스 이중 언어)
- **HITSZ 학술 포스터** (A0 / beamerposter)
- 공식 [`hitszthesis`](https://github.com/YangLaTeX/hitszthesis) **학위논문**
- **본문이 채워진 초고**: arXiv, Elsevier, 중국어 저널(`ctexart`)

템플릿을 고르고 이름을 지은 뒤 PDF / BIB / 그림을 끌어다 쓰면 됩니다.

<p align="center">
  <img src="./assets/demo/starter.webp" alt="템플릿 갤러리" width="700" />
</p>

### 선택적 두 번째 런타임

설정에서 **Codex**를 설치하고 로그인할 수 있습니다. 대화·스킬·에이전트는 그 대화에서 고른 런타임을 따릅니다.

---

## ClaudePrism에서 남긴 것

로컬 편집 기반입니다. 클라우드 워크스페이스가 아닙니다.

- **오프라인 LaTeX** — 내장 Tectonic, 첫 다운로드 후 캐시
- **라이브 PDF** — MuPDF + SyncTeX
- **캡처 후 질문** — `Ctrl+Shift+X` / `⌘⇧X` (`Ctrl+X`는 잘라내기)
- **Git 기록** — `.claudeprism/history.git/`
- **제안 diff** — 청크 단위 수락/거부 (`⌘Y` / `⌘N`)
- **Zotero** — OAuth와 인용 삽입
- **외부 편집기** — Cursor, VS Code, Zed, Sublime Text
- **다크 / 라이트**

<p align="center">
  <img src="./assets/demo/claudecommand.webp" alt="채팅과 슬래시 명령" width="600" />
</p>

<p align="center">
  <img src="./assets/demo/history.webp" alt="기록과 제안 변경" width="700" />
</p>

<p align="center">
  <img src="./assets/demo/capture_ask.webp" alt="캡처 후 질문" width="700" />
</p>

<p align="center">
  <img src="./assets/demo/zotero.webp" alt="Zotero" width="300" />
</p>

---

## 설치

[GitHub Releases](https://github.com/boshuaiYu/LocalPrism/releases)에서 최신 빌드를 받으세요.

macOS / Linux는 GitHub Actions, Windows는 `pnpm build:desktop`으로도 빌드할 수 있습니다.

## 기여

설정과 테스트는 [CONTRIBUTING.md](./CONTRIBUTING.md)를 보세요.

## 감사의 말

LocalPrism은 **다른 사람의 GitHub fork가 아닙니다**. 편집기, Tectonic, PDF, 채팅 셸은 [ClaudePrism](https://github.com/delibae/claude-prism)을 참고했고, 격리 홈, 기본 학술 팩, 에이전트, HIT / HITSZ 템플릿은 이 프로젝트의 추가분입니다.

- [ClaudePrism](https://github.com/delibae/claude-prism) ([delibae](https://github.com/delibae))
- [Open Prism](https://github.com/assistant-ui/open-prism) ([assistant-ui](https://github.com/assistant-ui), ClaudePrism의 출발점)

## 라이선스

[MIT](./LICENSE)
