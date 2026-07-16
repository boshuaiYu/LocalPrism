# Dual Runtime Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a runtime-neutral boundary and a native Codex app-server integration so Claude and Codex can be installed, authenticated, selected, streamed, cancelled, and resumed independently.

**Architecture:** Preserve every existing Claude Tauri command while adding shared runtime commands backed by a Claude compatibility adapter and a long-lived Codex JSON-RPC supervisor. Move new UI state to runtime-neutral types, then migrate chat tabs with an explicit runtime/session reference so a request can never cross from one runtime into the other.

**Tech Stack:** Rust 2021, Tokio, Serde JSON, Tauri 2, React 19, TypeScript 5.9, Zustand 5, Vitest 4, Codex app-server v2 JSON-RPC.

---

**Program position:** Plan 1 of 4. Complete this plan before `2026-07-16-runtime-skills-agents.md`. The application must remain usable with Claude at every commit.

## File map

**Create**

- `apps/desktop/src-tauri/src/runtime/mod.rs` - shared runtime types and Tauri command routing.
- `apps/desktop/src-tauri/src/runtime/events.rs` - stable event envelope and all event variants used by later plans.
- `apps/desktop/src-tauri/src/runtime/process.rs` - window/tab/session/turn route registry.
- `apps/desktop/src-tauri/src/runtime/claude.rs` - compatibility conversion for existing Claude status/session behavior.
- `apps/desktop/src-tauri/src/runtime/codex/mod.rs` - Codex facade and Tauri-facing operations.
- `apps/desktop/src-tauri/src/runtime/codex/discovery.rs` - executable discovery and version validation.
- `apps/desktop/src-tauri/src/runtime/codex/rpc.rs` - JSON-RPC framing, correlation, timeout, and inbound dispatch.
- `apps/desktop/src-tauri/src/runtime/codex/protocol.rs` - narrow app-server v2 request/response structs.
- `apps/desktop/src-tauri/src/runtime/codex/app_server.rs` - child-process lifecycle and initialize handshake.
- `apps/desktop/src-tauri/src/runtime/codex/event_mapper.rs` - initial message/turn mapping; plans 2 and 3 extend it.
- `apps/desktop/src/runtime/types.ts` - frontend runtime-neutral domain types.
- `apps/desktop/src/runtime/commands.ts` - typed Tauri wrappers.
- `apps/desktop/src/stores/runtime-store.ts` - independent Claude/Codex account and model state.
- `apps/desktop/src/stores/chat-persistence.ts` - versioned tab metadata persistence and migration.
- `apps/desktop/src/components/runtime/runtime-card.tsx` - one install/login/account card.
- `apps/desktop/src/components/runtime/runtime-settings.tsx` - both runtime cards and Codex login modes.
- `apps/desktop/src/components/runtime/runtime-selector.tsx` - runtime/model/reasoning selector.
- `apps/desktop/src/__tests__/stores/runtime-store.test.ts` - account/model isolation tests.
- `apps/desktop/src/__tests__/stores/dual-runtime-chat.test.ts` - dispatch, resume, cancel, and migration tests.
- `apps/desktop/src/__tests__/runtime/commands.test.ts` - typed command payload tests.

**Modify**

- `apps/desktop/src-tauri/src/lib.rs:1-10,568-649,712-718` - register modules, managed state, commands, and window cleanup.
- `apps/desktop/src-tauri/src/claude.rs:2005-2188,3185-3331,3334-4067` - expose adapter-safe status/session helpers without changing existing commands.
- `apps/desktop/src-tauri/src/claude_process.rs:13-355` - emit the shared route identity while retaining old Claude events.
- `apps/desktop/src-tauri/Cargo.toml:15-48` and `Cargo.lock` - add only protocol/runtime dependencies required by compiled code.
- `apps/desktop/src/stores/claude-chat-store.ts:91-207,548-688,739-969,1138-1450` - add runtime fields, persistence, and runtime dispatch.
- `apps/desktop/src/hooks/use-claude-events.ts:40-62,520-552` - keep legacy listeners and accept shared runtime events.
- `apps/desktop/src/components/environment-onboarding.tsx:45-429` - gate on at least one authenticated runtime.
- `apps/desktop/src/components/claude-setup.tsx:492-1459` - retain Claude/provider configuration and mount the shared settings shell.
- `apps/desktop/src/components/claude-chat/chat-composer.tsx` - use the runtime selector.
- `apps/desktop/src/components/claude-chat/session-selector.tsx` - list and resume sessions by runtime.
- `apps/desktop/src/components/claude-chat/chat-tab-bar.tsx` - display the tab runtime and prevent implicit runtime switches.
- `apps/desktop/src/App.tsx:27-177` - load sessions through runtime commands.
- Existing store tests under `apps/desktop/src/__tests__/stores/` - retain all Claude assertions.

### Task 1: Record the pre-change regression baseline

**Files:**

- Read: `package.json`
- Read: `apps/desktop/package.json`
- Read: `apps/desktop/src-tauri/Cargo.toml`
- Read: `apps/desktop/src/__tests__/stores/claude-chat-send-prompt.test.ts`

- [ ] **Step 1: Install the frozen JavaScript dependency graph**

Run:

```powershell
corepack pnpm install --frozen-lockfile
```

Expected: exit code `0` and no change to `pnpm-lock.yaml`.

- [ ] **Step 2: Run the existing frontend suite before production changes**

Run:

```powershell
corepack pnpm --filter @claude-prism/desktop test
```

Expected: every existing Vitest file passes. Save the test count in the implementation log.

- [ ] **Step 3: Run lint and the frontend production build**

Run:

```powershell
corepack pnpm exec biome check
corepack pnpm --filter @claude-prism/desktop build
```

Expected: both commands exit `0`.

- [ ] **Step 4: Run the existing Rust unit suite in a configured native toolchain**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
```

Expected: exit code `0`. On Windows, set the same `VCPKG_ROOT`, `VCPKGRS_TRIPLET=x64-windows-static-release`, and `TECTONIC_DEP_BACKEND=vcpkg` values used by `.github/workflows/build-desktop.yml` before treating a native-library error as a product failure.

### Task 2: Introduce shared runtime types without changing Claude behavior

**Files:**

- Create: `apps/desktop/src-tauri/src/runtime/mod.rs`
- Create: `apps/desktop/src-tauri/src/runtime/events.rs`
- Create: `apps/desktop/src-tauri/src/runtime/process.rs`
- Create: `apps/desktop/src-tauri/src/runtime/claude.rs`
- Create: `apps/desktop/src/runtime/types.ts`
- Modify: `apps/desktop/src-tauri/src/lib.rs:1-10`

- [ ] **Step 1: Write Rust serialization tests for the stable wire names**

Add to `runtime/mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_kind_uses_lowercase_wire_values() {
        assert_eq!(serde_json::to_string(&RuntimeKind::Claude).unwrap(), "\"claude\"");
        assert_eq!(serde_json::to_string(&RuntimeKind::Codex).unwrap(), "\"codex\"");
    }

    #[test]
    fn conversation_ref_requires_an_explicit_runtime() {
        let value = serde_json::to_value(ConversationRef {
            runtime: RuntimeKind::Codex,
            session_id: "thread-1".into(),
            project_path: "C:/work/paper".into(),
        })
        .unwrap();
        assert_eq!(value["runtime"], "codex");
        assert_eq!(value["sessionId"], "thread-1");
    }
}
```

- [ ] **Step 2: Run the new Rust tests and verify the module is missing**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml runtime::tests --lib
```

Expected: FAIL because `runtime` and its types are not registered.

- [ ] **Step 3: Add the shared Rust domain model**

Implement these exact public wire types in `runtime/mod.rs` and declare the `claude`, `events`, and `process` submodules. Task 3 adds `codex` when its module exists, keeping this commit compilable:

```rust
use serde::{Deserialize, Serialize};

pub mod claude;
pub mod events;
pub mod process;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind { Claude, Codex }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    pub models: bool,
    pub skills: bool,
    pub custom_agents: bool,
    pub subagents: bool,
    pub approvals: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAccount {
    pub runtime: RuntimeKind,
    pub installed: bool,
    pub authenticated: bool,
    pub version: Option<String>,
    pub account_label: Option<String>,
    pub auth_mode: Option<String>,
    pub capabilities: RuntimeCapabilities,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModel {
    pub runtime: RuntimeKind,
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub reasoning_efforts: Vec<String>,
    pub default_reasoning_effort: Option<String>,
    pub input_modalities: Vec<String>,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConversation {
    pub reference: ConversationRef,
    pub title: String,
    pub status: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConversationHistory {
    pub reference: ConversationRef,
    pub items: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRef {
    pub runtime: RuntimeKind,
    pub session_id: String,
    pub project_path: String,
}
```

Create matching TypeScript types in `src/runtime/types.ts`; use the same camelCase field names and the union `export type RuntimeKind = "claude" | "codex"`.

- [ ] **Step 4: Add the complete event envelope now so later plans only add mappers**

Implement `RuntimeEventEnvelope` in `runtime/events.rs` with `runtime`, `window_label`, `tab_id`, nullable `session_id` and `turn_id`, monotonic `sequence`, and a tagged `RuntimeEvent` enum. The enum must include `sessionStarted`, `turnStarted`, `turnCompleted`, `turnInterrupted`, `turnFailed`, `assistantDelta`, `assistantCompleted`, `reasoningSummaryDelta`, `toolStarted`, `toolOutput`, `toolCompleted`, `fileChange`, `usage`, `approvalRequested`, `userInputRequested`, `subagentDiscovered`, `subagentStatusChanged`, `warning`, and `unknown` variants. Use `#[serde(tag = "type", rename_all = "camelCase")]` so the frontend does not parse runtime-native payloads.

- [ ] **Step 5: Add the Claude compatibility adapter**

Implement `account_from_status(status: crate::claude::ClaudeStatus) -> RuntimeAccount` in `runtime/claude.rs`. Preserve `installed`, `authenticated`, version, and account email; use `provider_kind` as `auth_mode`; advertise models, skills, custom agents, and subagents; leave Codex-specific approvals false. Add a unit test with a fully populated `ClaudeStatus` and assert the conversion does not mutate provider configuration.

- [ ] **Step 6: Add an explicit route registry**

Implement in `runtime/process.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnRoute {
    pub runtime: RuntimeKind,
    pub window_label: String,
    pub tab_id: String,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
}

#[derive(Default)]
pub struct RuntimeProcessState {
    routes: tokio::sync::RwLock<std::collections::HashMap<String, TurnRoute>>,
}

impl RuntimeProcessState {
    pub async fn upsert(&self, route: TurnRoute) {
        self.routes.write().await.insert(
            format!("{}:{}", route.window_label, route.tab_id),
            route,
        );
    }

    pub async fn get(&self, window: &str, tab: &str) -> Option<TurnRoute> {
        self.routes.read().await.get(&format!("{window}:{tab}")).cloned()
    }

    pub async fn remove_window(&self, window: &str) {
        self.routes.write().await.retain(|_, route| route.window_label != window);
    }
}
```

- [ ] **Step 7: Run focused tests, then the unchanged Claude suite**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml runtime:: --lib
corepack pnpm --filter @claude-prism/desktop test -- claude-chat-store claude-setup-store
```

Expected: PASS, with existing Claude command names and payload assertions unchanged.

- [ ] **Step 8: Commit the shared boundary**

```powershell
git add apps/desktop/src-tauri/src/runtime apps/desktop/src-tauri/src/lib.rs apps/desktop/src/runtime apps/desktop/src/__tests__/runtime
git commit -m "refactor: add shared AI runtime domain"
```

### Task 3: Discover and validate the Codex executable

**Files:**

- Create: `apps/desktop/src-tauri/src/runtime/codex/discovery.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/codex/mod.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/mod.rs`

- [ ] **Step 1: Write pure candidate-order and version tests**

Add tests covering: an explicit test override, inherited `PATH`, `%APPDATA%/npm/codex.cmd`, Volta, Scoop, `%LOCALAPPDATA%/Programs`, `%ProgramFiles%/WindowsApps/OpenAI.Codex_*/app/resources/codex.exe`, `~/.local/bin/codex`, Homebrew, and npm/pnpm locations. Assert that a candidate is accepted only when `codex --version` exits successfully and stdout begins with `codex-cli `.

```rust
#[test]
fn parses_supported_version_output() {
    assert_eq!(parse_codex_version("codex-cli 0.135.0\n"), Some("0.135.0".into()));
    assert_eq!(parse_codex_version("Codex exists"), None);
}
```

- [ ] **Step 2: Run the discovery tests and verify failure**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml runtime::codex::discovery::tests --lib
```

Expected: FAIL because discovery functions do not exist.

- [ ] **Step 3: Implement validated discovery**

Use these concrete types and signatures:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexBinary {
    pub path: std::path::PathBuf,
    pub version: String,
}

pub fn candidate_paths(home: &std::path::Path) -> Vec<std::path::PathBuf>;
pub fn parse_codex_version(stdout: &str) -> Option<String>;
pub async fn discover_codex_binary() -> Result<CodexBinary, String>;
```

Deduplicate candidates by normalized path, invoke each candidate with `--version`, cap validation at five seconds, hide the console on Windows, and never persist the `WindowsApps` package version path.

Add `pub mod codex;` to `runtime/mod.rs` and declare `discovery` in `runtime/codex/mod.rs` in this same step.

- [ ] **Step 4: Add install/status commands**

Add provider-neutral commands with these signatures to `runtime/mod.rs`:

```rust
#[tauri::command]
pub async fn runtime_status(
    runtime: RuntimeKind,
) -> Result<RuntimeAccount, String>;

#[tauri::command]
pub async fn runtime_install(
    runtime: RuntimeKind,
    window: tauri::WebviewWindow,
) -> Result<bool, String>;
```

At this stage, `runtime_status(Claude)` delegates to the existing Claude status implementation, while `runtime_status(Codex)` reports validated installation/version with `authenticated=false`; Task 5 adds app-server account state without changing the frontend command name. `runtime_install(Codex)` launches the current official installer command for the OS, streams redacted install output, and re-runs validated discovery. Do not store Codex credentials or a binary path in `anthropic-auth.json`.

- [ ] **Step 5: Verify the real local candidate and the no-Codex path**

Run:

```powershell
codex --version
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml runtime::codex::discovery::tests --lib
```

Expected: local output has the form `codex-cli <version>` and all tests pass. Unit tests must also prove `installed=false` when every validator fails.

- [ ] **Step 6: Commit discovery**

```powershell
git add apps/desktop/src-tauri/src/runtime/codex apps/desktop/src-tauri/src/runtime/mod.rs
git commit -m "feat: discover and install Codex CLI"
```

### Task 4: Build the JSON-RPC transport and app-server supervisor

**Files:**

- Create: `apps/desktop/src-tauri/src/runtime/codex/rpc.rs`
- Create: `apps/desktop/src-tauri/src/runtime/codex/protocol.rs`
- Create: `apps/desktop/src-tauri/src/runtime/codex/app_server.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/codex/mod.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs:568-570`

- [ ] **Step 1: Write transport tests with `tokio::io::duplex`**

Cover interleaved responses, notifications, server requests, a malformed line followed by a valid line, request timeout cleanup, and string/numeric request IDs. The core assertion is:

```rust
let response = client.request("account/read", serde_json::json!({}), Duration::from_secs(1)).await?;
assert_eq!(response["requiresOpenaiAuth"], true);
assert_eq!(client.pending_len().await, 0);
```

- [ ] **Step 2: Run the transport tests and verify failure**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml runtime::codex::rpc::tests --lib
```

Expected: FAIL because `RpcClient` is missing.

- [ ] **Step 3: Implement correlated JSON-RPC framing**

Implement these exact public surfaces in `rpc.rs`:

```rust
pub type OutboundRequestId = u64;

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum RpcId {
    Number(u64),
    String(String),
}

#[derive(Debug)]
pub enum RpcInbound {
    Notification { method: String, params: serde_json::Value },
    ServerRequest { id: RpcId, method: String, params: serde_json::Value },
    Malformed { line: String, error: String },
}

pub struct RpcClient {
    writer: tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Unpin + Send>>,
    next_id: std::sync::atomic::AtomicU64,
    pending: tokio::sync::Mutex<std::collections::HashMap<OutboundRequestId, tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>>>,
}

impl RpcClient {
    pub async fn request(&self, method: &str, params: serde_json::Value, timeout: std::time::Duration) -> Result<serde_json::Value, String>;
    pub async fn respond(&self, id: RpcId, result: serde_json::Value) -> Result<(), String>;
    pub async fn respond_error(&self, id: RpcId, code: i64, message: &str) -> Result<(), String>;
    pub async fn pending_len(&self) -> usize;
}
```

Each write is exactly one compact JSON object plus `\n`. Redact secrets before logging and retain at most 64 KiB of recent stderr.

- [ ] **Step 4: Implement the supervisor startup contract**

`CodexAppServerState` must own one supervisor per Tauri app. `ensure_started()` discovers Codex, spawns `codex app-server --listen stdio://`, starts stdout/stderr readers, sends `initialize` with `{clientInfo:{name:"claude-prism",title:"ClaudePrism",version:<app version>},capabilities:{experimentalApi:true}}`, sends the `initialized` notification after a successful response, and becomes ready only then. On unexpected exit it retries once; after a second exit it marks all in-flight routes failed and exposes diagnostics. Accept app-server frames with or without a `jsonrpc` field.

```rust
#[derive(Default)]
pub struct CodexAppServerState {
    inner: tokio::sync::Mutex<Option<CodexAppServer>>,
}

impl CodexAppServerState {
    pub async fn request(&self, app: &tauri::AppHandle, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String>;
    pub async fn shutdown(&self) -> Result<(), String>;
}
```

- [ ] **Step 5: Register state and clean shutdown**

Add `.manage(runtime::codex::CodexAppServerState::default())` and `.manage(runtime::process::RuntimeProcessState::default())` in `lib.rs`. On window close remove only that window's routes; on application exit call Codex shutdown. Keep `.manage(claude::ClaudeProcessState::default())` unchanged.

Until plan 3 mounts the interactive approval UI, every server-initiated request must still receive a terminal response: known command/file approval methods are safely declined, and unsupported methods receive JSON-RPC error `-32601` plus a visible warning event. Never leave a request pending because the frontend cannot yet render it.

- [ ] **Step 6: Run transport, lifecycle, and Claude regression tests**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml runtime::codex --lib
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml claude_process --lib
```

Expected: PASS; killing a fake server yields one restart and never yields a false successful turn.

- [ ] **Step 7: Commit the app-server foundation**

```powershell
git add apps/desktop/src-tauri/src/runtime/codex apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock
git commit -m "feat: add Codex app-server supervisor"
```

### Task 5: Add Codex account and dynamic model APIs

**Files:**

- Modify: `apps/desktop/src-tauri/src/runtime/codex/protocol.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/codex/mod.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/mod.rs`
- Create: `apps/desktop/src/runtime/commands.ts`
- Create: `apps/desktop/src/__tests__/runtime/commands.test.ts`
- Create: `apps/desktop/src/__tests__/stores/runtime-store.test.ts`
- Create: `apps/desktop/src/stores/runtime-store.ts`

- [ ] **Step 1: Write protocol conversion tests from real v2-shaped fixtures**

Test ChatGPT, API-key, and logged-out `account/read` responses. Test two-page `model/list`, hidden-model filtering, all reasoning efforts (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`), and `text`/`image` modalities.

- [ ] **Step 2: Run the tests and verify failure**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml account_and_models --lib
```

Expected: FAIL because the v2 response converters are missing.

- [ ] **Step 3: Implement only the required v2 protocol structs**

Define serde types for `account/read`, `account/login/start`, `account/login/cancel`, `account/logout`, `account/login/completed` and `account/updated` notifications, and paginated `model/list`. Login requests are exactly:

```json
{"type":"chatgpt","codexStreamlinedLogin":true}
{"type":"chatgptDeviceCode"}
{"type":"apiKey","apiKey":"<provided only to this request>"}
```

Map login responses to the tagged variants `apiKey`, `chatgpt { authUrl, loginId }`, and `chatgptDeviceCode { verificationUrl, userCode, loginId }`. Never serialize the API key into frontend state or logs.

- [ ] **Step 4: Add shared account/model commands**

Register these commands in `lib.rs`:

```rust
runtime::runtime_status,
runtime::runtime_login_start,
runtime::runtime_login_cancel,
runtime::runtime_logout,
runtime::runtime_list_models,
```

`runtime_list_models(Codex)` follows every `nextCursor`; it returns only non-hidden `RuntimeModel` values. Claude returns its existing aliases and OpenAI-compatible entries through the adapter without relabeling them as Codex.

- [ ] **Step 5: Write the frontend store test first**

In `runtime-store.test.ts`, mock `runtime_status` so Claude is authenticated and Codex is installed but logged out; then authenticate Codex and assert the Claude object is byte-for-byte unchanged. Mock two Codex model pages at the backend boundary and assert the store does not compile in a fallback Codex model ID.

In `commands.test.ts`, assert each wrapper sends the exact camelCase Tauri payload and never includes an API key in returned/storeable objects.

- [ ] **Step 6: Implement typed commands and isolated state**

Use this state shape in `runtime-store.ts`:

```ts
interface RuntimeState {
  accounts: Record<RuntimeKind, RuntimeAccount>;
  models: Record<RuntimeKind, RuntimeModel[]>;
  loading: Partial<Record<RuntimeKind, boolean>>;
  login: Partial<Record<RuntimeKind, RuntimeLoginState | null>>;
  refresh(runtime?: RuntimeKind): Promise<void>;
  install(runtime: RuntimeKind): Promise<boolean>;
  startLogin(runtime: RuntimeKind, mode: "browser" | "device-code" | "api-key", apiKey?: string): Promise<void>;
  cancelLogin(runtime: RuntimeKind): Promise<void>;
  logout(runtime: RuntimeKind): Promise<void>;
  refreshModels(runtime: RuntimeKind): Promise<void>;
}

type RuntimeLoginState =
  | { mode: "browser"; status: "waiting"; loginId: string; authUrl: string }
  | { mode: "device-code"; status: "waiting"; loginId: string; verificationUrl: string; userCode: string }
  | { mode: "api-key"; status: "complete"; loginId: null }
  | { mode: "browser" | "device-code" | "api-key"; status: "error"; loginId: string | null; message: string };
```

`startLogin` clears the API-key argument immediately after `invoke` resolves/rejects. The store keeps only `loginId`, URLs, user code, mode, and status.

The backend matches `account/login/completed` by `loginId`, refreshes `account/read`, and emits a redacted `runtime-account-updated` event. `runtime-store` owns one listener for that event, updates only the named runtime, and falls back to bounded status polling so a missed notification cannot leave the UI waiting forever.

- [ ] **Step 7: Run Rust and frontend tests**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml account_and_models --lib
corepack pnpm --filter @claude-prism/desktop test -- runtime-store
```

Expected: PASS and independent account state.

- [ ] **Step 8: Commit account/model support**

```powershell
git add apps/desktop/src-tauri/src/runtime apps/desktop/src-tauri/src/lib.rs apps/desktop/src/runtime apps/desktop/src/stores/runtime-store.ts apps/desktop/src/__tests__/stores/runtime-store.test.ts
git commit -m "feat: add Codex login and model discovery"
```

### Task 6: Add Codex threads, turns, streaming, cancellation, and resume

**Files:**

- Modify: `apps/desktop/src-tauri/src/runtime/codex/protocol.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/codex/event_mapper.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/codex/mod.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/mod.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs:590-649`

- [ ] **Step 1: Write payload-builder tests**

Assert a new thread sends `thread/start` with `cwd`, selected `model`, `approvalPolicy:"on-request"`, `sandbox:"workspace-write"`, and `threadSource:"user"`. Assert `turn/start` sends `threadId`, text input, selected `model`, and selected `effort`. Assert cancellation sends both `threadId` and `turnId`; archive sends only `threadId`.

- [ ] **Step 2: Write lifecycle mapping tests**

Feed `thread/started`, `turn/started`, `item/agentMessage/delta`, `item/completed`, `turn/completed`, and an error notification into the mapper. Assert stable sequence numbers, explicit tab routing, completed item authority, and no duplicate assistant content when both deltas and completed items arrive.

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml codex_turn --lib
```

Expected: FAIL because thread/turn builders and mapping are absent.

- [ ] **Step 4: Implement shared request types and commands**

Add:

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTurnRequest {
    pub runtime: RuntimeKind,
    pub project_path: String,
    pub tab_id: String,
    pub session_id: Option<String>,
    pub prompt: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub agent_id: Option<String>,
}

#[tauri::command]
pub async fn runtime_start_turn(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request: RuntimeTurnRequest,
    routes: tauri::State<'_, RuntimeProcessState>,
    codex: tauri::State<'_, CodexAppServerState>,
    claude: tauri::State<'_, crate::claude::ClaudeProcessState>,
) -> Result<(), String>;
#[tauri::command]
pub async fn runtime_interrupt_turn(
    window: tauri::WebviewWindow,
    runtime: RuntimeKind,
    tab_id: String,
    routes: tauri::State<'_, RuntimeProcessState>,
    codex: tauri::State<'_, CodexAppServerState>,
    claude: tauri::State<'_, crate::claude::ClaudeProcessState>,
) -> Result<(), String>;
#[tauri::command]
pub async fn runtime_list_conversations(
    app: tauri::AppHandle,
    runtime: RuntimeKind,
    project_path: String,
    codex: tauri::State<'_, CodexAppServerState>,
) -> Result<Vec<RuntimeConversation>, String>;
#[tauri::command]
pub async fn runtime_read_conversation(
    app: tauri::AppHandle,
    reference: ConversationRef,
    codex: tauri::State<'_, CodexAppServerState>,
) -> Result<RuntimeConversationHistory, String>;
#[tauri::command]
pub async fn runtime_archive_conversation(
    app: tauri::AppHandle,
    reference: ConversationRef,
    codex: tauri::State<'_, CodexAppServerState>,
) -> Result<(), String>;
```

Claude command paths delegate to the existing execute/resume/cancel/list/load/delete code. Codex starts/resumes a thread, starts the turn, stores its route, and emits only normalized runtime events. Codex UI deletion maps to `thread/archive`.

- [ ] **Step 5: Implement safe restart semantics**

On app-server restart, call `thread/resume` for subscribed nonterminal threads. Mark every previously in-flight turn as failed before retry; never emit `turnCompleted` for an interrupted connection. One tab cancellation looks up its own `TurnRoute` and cannot cancel another window/tab.

- [ ] **Step 6: Run the lifecycle tests**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml codex_turn --lib
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml runtime::process --lib
```

Expected: PASS, including concurrent routes and independent cancellation.

- [ ] **Step 7: Commit thread/turn support**

```powershell
git add apps/desktop/src-tauri/src/runtime apps/desktop/src-tauri/src/lib.rs
git commit -m "feat: run Codex conversations through app-server"
```

### Task 7: Add dual-runtime onboarding and settings

**Files:**

- Create: `apps/desktop/src/components/runtime/runtime-card.tsx`
- Create: `apps/desktop/src/components/runtime/runtime-settings.tsx`
- Modify: `apps/desktop/src/components/environment-onboarding.tsx:45-429`
- Modify: `apps/desktop/src/components/claude-setup.tsx:492-1459`
- Modify: `apps/desktop/src/__tests__/stores/runtime-store.test.ts`

- [ ] **Step 1: Add readiness tests before UI changes**

Export and test this pure predicate:

```ts
export function hasReadyRuntime(accounts: Record<RuntimeKind, RuntimeAccount>) {
  return Object.values(accounts).some(
    (account) => account.installed && account.authenticated,
  );
}
```

Cover Claude-only, Codex-only, both authenticated, neither authenticated, and one runtime failing while the other remains ready.

- [ ] **Step 2: Run the readiness tests and verify failure**

Run:

```powershell
corepack pnpm --filter @claude-prism/desktop test -- runtime-store
```

Expected: FAIL because the shared readiness helper/UI is missing.

- [ ] **Step 3: Implement independent cards and login modes**

`RuntimeCard` receives one `RuntimeAccount` and action callbacks. The Codex card exposes browser, device-code, and API-key login; browser/device-code data comes from app-server. The API-key input is component-local, has `autoComplete="off"`, and is cleared after submit. Claude continues using the current Claude setup and OpenAI-compatible provider UI.

- [ ] **Step 4: Replace the Claude-only onboarding gate**

Render the workspace when `hasReadyRuntime(accounts)` is true. Keep both cards reachable in settings after readiness. A Codex error must not overwrite Claude status, and an OpenAI-compatible credential remains grouped under Claude-backed providers.

- [ ] **Step 5: Run tests and production build**

Run:

```powershell
corepack pnpm --filter @claude-prism/desktop test -- runtime-store claude-setup-store
corepack pnpm --filter @claude-prism/desktop build
```

Expected: PASS and no TypeScript errors.

- [ ] **Step 6: Commit onboarding**

```powershell
git add apps/desktop/src/components/runtime apps/desktop/src/components/environment-onboarding.tsx apps/desktop/src/components/claude-setup.tsx apps/desktop/src/__tests__/stores/runtime-store.test.ts
git commit -m "feat: support independent Claude and Codex setup"
```

### Task 8: Migrate chat tabs and route each request explicitly

**Files:**

- Create: `apps/desktop/src/stores/chat-persistence.ts`
- Create: `apps/desktop/src/__tests__/stores/dual-runtime-chat.test.ts`
- Modify: `apps/desktop/src/stores/claude-chat-store.ts:91-207,548-688,739-969,1138-1450`
- Modify: `apps/desktop/src/hooks/use-claude-events.ts:40-62,520-552`
- Modify: `apps/desktop/src/runtime/commands.ts`

- [ ] **Step 1: Write migration tests reflecting the real current store**

The current store is not Zustand-persisted; only the provider selection key exists in session storage. Test a missing persisted document and a version-1 document without runtime fields. Both must become Claude tabs without changing `sessionId` or provider keys.

```ts
expect(migratePersistedChat(null).tabs[0]?.runtime).toBe("claude");
expect(migratePersistedChat(legacy).tabs[0]?.sessionRef).toEqual({
  runtime: "claude",
  sessionId: "session-1",
  projectPath: "/paper",
});
```

- [ ] **Step 2: Write dispatch and isolation tests**

Assert Claude calls `runtime_start_turn` with `runtime:"claude"`; Codex calls it with `runtime:"codex"`, selected dynamic model, and reasoning effort. Assert resume uses a typed `ConversationRef`, cancel includes the tab runtime, and changing runtime on a tab with a session creates a new session only after explicit confirmation.

- [ ] **Step 3: Run the new tests and verify failure**

Run:

```powershell
corepack pnpm --filter @claude-prism/desktop test -- dual-runtime-chat
```

Expected: FAIL because tab runtime fields and shared dispatch do not exist.

- [ ] **Step 4: Implement versioned metadata persistence**

Use key `claude-prism.chat-tabs.v2` and persist only tab identity/title/project path, runtime, session reference, selected model/effort/agent, and provider key. Do not persist streaming flags, API keys, approval requests, raw events, or pasted temporary files.

```ts
export interface PersistedChatDocument {
  version: 2;
  activeTabId: string;
  tabs: Array<Pick<TabState,
    "id" | "title" | "projectPath" | "runtime" | "sessionRef" |
    "providerKey" | "runtimeModel" | "reasoningEffort" | "agentId"
  >>;
}
```

- [ ] **Step 5: Add explicit runtime fields to `TabState`**

Add `runtime: RuntimeKind`, `sessionRef: ConversationRef | null`, `runtimeModel: string | null`, `reasoningEffort: string | null`, and `agentId: string | null`. Retain `sessionId` during migration as a projected compatibility field until all existing components use `sessionRef`.

- [ ] **Step 6: Replace send/resume/cancel branching with typed commands**

All new sends call `startRuntimeTurn(request)`. The backend adapter decides Claude versus Codex. The frontend never chooses a backend by inspecting a model name. `runtime-event` listeners update only the matching `tabId` and runtime; legacy `claude-output`, `claude-complete`, and `claude-error` listeners stay active until the Claude adapter emits equivalent shared events.

- [ ] **Step 7: Run all chat tests**

Run:

```powershell
corepack pnpm --filter @claude-prism/desktop test -- claude-chat-store claude-chat-send-prompt dual-runtime-chat multi-tab-merge
```

Expected: PASS, including all pre-existing OpenAI-compatible provider tests.

- [ ] **Step 8: Commit chat migration**

```powershell
git add apps/desktop/src/stores apps/desktop/src/runtime apps/desktop/src/hooks/use-claude-events.ts apps/desktop/src/__tests__/stores
git commit -m "feat: route chat tabs by explicit AI runtime"
```

### Task 9: Add runtime-aware model/session controls and close the phase

**Files:**

- Create: `apps/desktop/src/components/runtime/runtime-selector.tsx`
- Modify: `apps/desktop/src/components/claude-chat/chat-composer.tsx`
- Modify: `apps/desktop/src/components/claude-chat/session-selector.tsx`
- Modify: `apps/desktop/src/components/claude-chat/chat-tab-bar.tsx`
- Modify: `apps/desktop/src/App.tsx:27-177`

- [ ] **Step 1: Extract and test selector option builders**

Pure builders must return Claude aliases for Claude, dynamically fetched model entries for Codex, only reasoning efforts supported by the selected Codex model, and only sessions whose `ConversationRef.runtime` matches the current tab.

- [ ] **Step 2: Run selector tests and verify failure**

Run:

```powershell
corepack pnpm --filter @claude-prism/desktop test -- dual-runtime-chat
```

Expected: FAIL on the new option assertions.

- [ ] **Step 3: Implement the runtime/model/reasoning control**

Selection order is runtime/provider, model, reasoning effort, then a disabled agent control that plan 2 activates. Runtime changes on a tab with an existing session display a confirmation; acceptance clears `sessionRef` and messages for a new session, rejection restores the original runtime.

- [ ] **Step 4: Implement runtime-scoped session list/read/archive**

`App.tsx` and `session-selector.tsx` call shared commands with an explicit runtime. Codex list/read uses app-server; Claude list/history remains unchanged through the adapter. The delete label for Codex says `Archive` and calls `thread/archive`.

- [ ] **Step 5: Run the complete phase gate**

Run:

```powershell
corepack pnpm --filter @claude-prism/desktop test
corepack pnpm exec biome check
corepack pnpm --filter @claude-prism/desktop build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
git status --short
```

Expected: all commands exit `0`; status contains only intended implementation files before the final commit.

- [ ] **Step 6: Perform live dual-runtime smoke checks**

With both CLIs installed, verify: Claude login remains valid after Codex login; Codex browser or device login reaches authenticated state; `model/list` populates the selector; one prompt streams in each runtime; cancelling one tab does not stop the other; each session resumes through its own runtime.

- [ ] **Step 7: Commit the working foundation**

```powershell
git add apps/desktop/src apps/desktop/src-tauri/src apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock
git commit -m "feat: complete dual Claude and Codex runtime foundation"
```

## Phase exit evidence

- Existing Claude and OpenAI-compatible store tests pass without weakened assertions.
- Claude and Codex installation/authentication states coexist in one UI session.
- Codex models come from paginated `model/list` and selected effort reaches `turn/start`.
- Claude and Codex prompts, cancellation, list/read/resume, and archive/delete routing are isolated by `RuntimeKind` and tab.
- No Codex token or API key appears in ClaudePrism persistence or logs.
