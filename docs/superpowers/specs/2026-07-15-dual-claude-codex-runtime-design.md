# Dual Claude and Codex Runtime Design

**Status:** SUPERSEDED for chat execution and login by [2026-09-17 Single-Provider Runtime Design](./2026-09-17-single-provider-runtime-design.md). Keep this document only as historical context for skills/agents work that still mentions `RuntimeKind`.

**Previous status:** Approved in conversation on 2026-07-15; independent-review amendment requested on 2026-07-16

**Scope:** Add a first-class Codex runtime while preserving all existing Claude Code and OpenAI-compatible behavior. Extend skill management to Claude and Codex, add runtime-native custom agents with assigned skills, expose subagent activity, and keep the Windows installer workflow.

## 1. Context

ClaudePrism is a Tauri 2 desktop application with a React/TypeScript frontend and a Rust backend. Its AI execution path is currently centered on Claude Code:

- `apps/desktop/src-tauri/src/claude.rs` owns Claude discovery, authentication, provider credentials, execution, and session-file access.
- `apps/desktop/src-tauri/src/claude_process.rs` owns Claude child processes and Claude JSONL streaming.
- `apps/desktop/src/stores/claude-chat-store.ts` sends every chat turn through Claude-named Tauri commands.
- `apps/desktop/src/hooks/use-claude-events.ts` parses Claude-specific stream events.
- `apps/desktop/src-tauri/src/skills.rs` installs only to `.claude/skills`.
- `apps/desktop/src/components/scientific-skills/scientific-skills-onboarding.tsx` presents skills as Claude-only assets.

The existing OpenAI-compatible provider path is not a Codex runtime. It adapts compatible model APIs to the Anthropic protocol and still starts Claude Code. A native Codex integration must therefore be a peer runtime rather than another provider credential inside the Claude adapter.

## 2. Goals

1. Detect, install, authenticate, and log out of Claude Code and Codex independently.
2. Allow Claude Code and Codex to remain installed and authenticated at the same time.
3. Fetch the available Codex model catalog dynamically and run selected Codex models with supported reasoning effort.
4. Preserve the current Claude Code, Anthropic-compatible, OpenAI-compatible, project, editor, PDF, history, and session behavior.
5. Import and manage additional skills for Claude, Codex, or both at user or project scope.
6. Create and edit runtime-native custom agents, assign skills to them, and select an agent for a conversation.
7. Show live and completed subagent activity with parent-child relationships and inspectable results.
8. Continue producing and validating Windows NSIS `.exe` and MSI installers.
9. Prove behavior with automated tests, protocol fixtures, builds, and Windows smoke tests.

## 3. Non-goals

- Replacing Claude Code with Codex or migrating Claude sessions into Codex sessions.
- Treating a ChatGPT/Codex login as an OpenAI-compatible API credential.
- Bundling a fixed Codex executable inside ClaudePrism. The application discovers or installs the official external CLI, matching the current Claude setup model.
- Displaying hidden chain-of-thought or fabricating subagent details a runtime does not expose.
- Making assigned skills an exclusive allow-list. Assignment means the skill is explicitly preloaded or enabled for the custom agent. Other globally discoverable skills retain the native runtime's normal discovery behavior.
- Redesigning unrelated editor, LaTeX, PDF, Zotero, history, or project features.

## 4. Considered Approaches

### 4.1 Codex app-server integration - selected

Run `codex app-server --listen stdio://` and communicate over newline-delimited JSON-RPC. This surface supports account state, managed login, model discovery, threads, turns, approvals, skills, streamed items, and persisted subagent relationships. It is the only option that covers the full requested feature set through a rich-client interface.

### 4.2 `codex exec --json`

This is simpler for basic prompt execution and remains useful as a diagnostic tool, but it does not provide a complete rich-client account, approval, skill, and subagent lifecycle. It is not the primary runtime and will not be used as a silent fallback that falsely appears feature-complete.

### 4.3 Direct OpenAI Responses API

This would create an API provider, not a Codex client integration. It would not reuse Codex's ChatGPT-managed authentication, local configuration, native skills, custom agents, or thread lifecycle. It does not satisfy the goal.

## 5. Architecture

The application introduces a provider-neutral runtime boundary while retaining compatibility wrappers for the existing Claude implementation.

```text
React UI
  -> runtime/account/chat stores
      -> Tauri runtime commands
          -> ClaudeCodeRuntime -> existing Claude modules and CLI
          -> CodexRuntime      -> codex app-server JSON-RPC
      <- normalized runtime events
          -> messages, tool calls, file changes, approvals, agent runs
```

### 5.1 Proposed Rust modules

```text
apps/desktop/src-tauri/src/
  runtime/
    mod.rs                 Shared types, traits, command routing, capability flags
    events.rs              Stable application event schema
    process.rs             Window/tab execution registry and cancellation semantics
    claude.rs              Compatibility adapter over existing Claude functions
    codex/
      mod.rs               Codex runtime facade
      discovery.rs         Cross-platform CLI discovery and version checks
      app_server.rs        Process lifecycle, initialize handshake, restart policy
      rpc.rs               Request IDs, pending responses, notifications, server requests
      protocol.rs          Narrow serde types used by ClaudePrism
      event_mapper.rs      Codex protocol to normalized runtime events
  agents/
    mod.rs                 Agent CRUD commands and common validation
    claude.rs              Claude Markdown/frontmatter parser and writer
    codex.rs               Codex TOML parser and writer
  skills.rs                Runtime-aware destinations plus managed manifest
```

Existing public Claude Tauri commands remain registered during migration. New provider-neutral commands route by `RuntimeKind`. This avoids breaking existing frontend behavior and tests while the UI moves to the shared layer.

### 5.2 Proposed frontend modules

```text
apps/desktop/src/
  runtime/
    types.ts               Runtime-neutral account, model, session, event types
    commands.ts            Typed Tauri command wrappers
    event-normalizer.ts    Defensive validation of normalized events
  stores/
    runtime-store.ts       Claude and Codex installation/authentication state
    agent-store.ts         Agent profiles and CRUD state
    skill-store.ts         Runtime/scope-aware skill catalog
  components/
    runtime/               Account setup and provider/model selection
    agents/                Agent library and editor
    subagents/             Active/done tree, run details, status presentation
```

The current `claude-chat-store.ts` is migrated incrementally. Its persisted storage schema gains a versioned migration rather than being replaced in one change.

## 6. Shared Domain Model

```ts
type RuntimeKind = "claude" | "codex";

interface RuntimeAccount {
  runtime: RuntimeKind;
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  accountLabel: string | null;
  authMode: string | null;
  capabilities: RuntimeCapabilities;
  error: string | null;
}

interface RuntimeModel {
  runtime: RuntimeKind;
  id: string;
  displayName: string;
  description: string | null;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  inputModalities: string[];
  isDefault: boolean;
}

interface ConversationRef {
  runtime: RuntimeKind;
  sessionId: string;
  projectPath: string;
}

interface AgentProfile {
  id: string;
  runtime: RuntimeKind;
  scope: "user" | "project";
  name: string;
  description: string;
  instructions: string;
  model: string | null;
  reasoningEffort: string | null;
  sandboxMode: string | null;
  skillIds: string[];
  sourcePath: string;
}

interface AgentRun {
  id: string;
  parentId: string | null;
  rootConversationId: string;
  runtime: RuntimeKind;
  agentName: string;
  agentRole: string | null;
  model: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt: number | null;
  summary: string | null;
  error: string | null;
}
```

Runtime-specific payloads may be retained in a non-persisted `raw` diagnostic field, but UI state and persisted session references use these shared types.

## 7. Codex Runtime

### 7.1 CLI discovery and installation

Discovery validates candidates by executing `codex --version`; an existing file is not enough. Candidate sources include:

- the inherited process `PATH`;
- user and machine registry `PATH` values on Windows;
- `%APPDATA%\\npm`, pnpm, Volta, Scoop, and common local binary directories;
- the currently installed OpenAI Codex Windows application package, rediscovered on every status check rather than persisted as a versioned absolute path;
- standard Unix local and package-manager paths.

Installation launches the current official OpenAI installer for the operating system. Installer output is streamed with secrets and signed URLs redacted. The setup flow re-runs discovery and `--version` after installation.

### 7.2 App-server lifecycle

One `CodexAppServerState` is owned by the Tauri application, not by an individual window. It stores:

- child process and stdin writer;
- monotonically increasing JSON-RPC request ID;
- pending request senders keyed by ID;
- initialized capabilities and protocol version information;
- thread-to-window/tab subscriptions;
- login attempts;
- restart count and last fatal error.

Startup sequence:

1. Discover and validate the Codex executable.
2. Spawn `codex app-server --listen stdio://` with hidden-console behavior on Windows.
3. Read stdout as JSONL and stderr separately.
4. Send `initialize` with ClaudePrism client metadata and the minimum required capabilities.
5. Mark the runtime ready only after a successful response.
6. Read account and model state.

The JSON-RPC loop supports interleaved responses, notifications, and server-initiated requests. Malformed lines are logged safely and do not crash the reader. Unknown notification and item variants are preserved as generic events so newer Codex releases degrade visibly rather than breaking the stream.

If the process exits unexpectedly, ClaudePrism performs one automatic restart, reinitializes, refreshes account/model state, and re-subscribes known threads where supported. A second failure is surfaced to the user with diagnostics and an update action. No in-flight turn is reported as successful after a crash.

### 7.3 Authentication

Codex authentication is owned by Codex. ClaudePrism never copies Codex tokens into `anthropic-auth.json` or its own settings.

Supported flows:

- ChatGPT managed browser login;
- ChatGPT device-code login;
- OpenAI API key login;
- logout and account refresh.

The UI calls `account/login/start`, opens or displays the returned authorization data, and waits for the matching completion notification. API keys are sent directly to the local app-server request and are not persisted by the React store. Login cancellation uses the matching login ID.

Claude authentication keeps its existing flow. Logging into or out of one runtime does not change the other runtime.

### 7.4 Models

Codex models come from paginated `model/list` results. The UI stores the model ID and uses the returned reasoning-effort and modality metadata. No Codex model ID is compiled into the application as the permanent catalog.

Claude model aliases and OpenAI-compatible provider models retain their current behavior. The shared UI presents capabilities without forcing the two catalogs into identical fields.

### 7.5 Threads and turns

- New Codex conversations use `thread/start` with project `cwd`, selected model, reasoning effort, and the user-selected approval/sandbox policy.
- Prompts use `turn/start`.
- Cancellation uses `turn/interrupt` and is scoped to the selected tab/thread.
- Resume, list, read, and fork behavior use Codex thread APIs rather than scanning Codex files. Deleting a Codex conversation in the UI maps to thread archival; it does not delete Codex rollout files.
- Claude sessions continue to use the existing Claude session implementation.

Each tab persists an explicit runtime and session reference. Runtime is never inferred from a model name or credential ID.

## 8. Normalized Events and Approvals

The backend emits a stable `runtime-event` envelope:

```ts
interface RuntimeEventEnvelope {
  runtime: RuntimeKind;
  windowLabel: string;
  tabId: string;
  sessionId: string | null;
  turnId: string | null;
  sequence: number;
  event: RuntimeEvent;
}
```

`RuntimeEvent` covers:

- session/turn started, completed, interrupted, and failed;
- assistant message start, delta, and completion;
- reasoning summary start, delta, and completion when the runtime exposes it;
- command/tool start, output, completion, and error;
- file change and aggregated diff updates;
- token usage;
- approval and user-input requests;
- subagent discovered, status changed, message/result available, and closed;
- generic warning and unknown runtime item.

The mapper uses `item/completed` as the authoritative Codex item result and deltas only for incremental rendering. Duplicate or out-of-order lifecycle events are merged idempotently by runtime item ID.

Approval dialogs show the source runtime, thread, agent, command or file change, requested permission, and persistence scope. Server-initiated requests always receive an explicit allow, deny, cancel, or unsupported response; they are never left pending indefinitely because the client cannot render them.

## 9. Skills

### 9.1 Destinations

| Runtime | User scope | Project scope |
|---|---|---|
| Claude | `~/.claude/skills` | `<project>/.claude/skills` |
| Codex | `~/.agents/skills` | `<project>/.agents/skills` |

The backend returns resolved destinations to the frontend; React does not hardcode home-directory syntax.

### 9.2 Catalog and managed manifest

ClaudePrism maintains a small manifest under its application configuration directory. Each entry records:

- stable skill ID and declared name;
- source type and source path or curated package identifier;
- content fingerprint;
- managed destinations;
- runtime and scope;
- install/update timestamp.

Deletion removes only destinations owned by a matching manifest entry. Existing unmanaged skills remain visible and assignable but cannot be recursively deleted by an "uninstall all managed skills" action.

### 9.3 Import validation

An imported skill must contain `SKILL.md`. The parser reads YAML frontmatter and validates at least `name` and `description` for cross-runtime installation. A legacy Claude skill without standard metadata can be imported as Claude-only after the UI explains why it is not Codex-compatible. ClaudePrism does not silently rewrite user instructions to make a skill appear compatible.

Copies use a temporary sibling directory and atomic replacement after validation. A failed copy leaves the previous installed version intact.

### 9.4 Runtime visibility verification

Filesystem presence alone does not prove Codex visibility. After a Codex install or change, ClaudePrism refreshes `skills/list` for the relevant project and records any discovery errors. For Claude, the application refreshes its slash-command/skill catalog and exposes any missing-skill warnings from Claude execution.

## 10. Custom Agents

### 10.1 Claude agents

Claude agent definitions are Markdown files with YAML frontmatter in:

- `~/.claude/agents/*.md` for user scope;
- `<project>/.claude/agents/*.md` for project scope.

The editor manages `name`, `description`, instructions, model, effort, permission mode, tools, and `skills`. Assigned skills are written to the native `skills:` list so their full content is preloaded when the subagent starts.

### 10.2 Codex agents

Codex agent definitions are standalone TOML files in:

- `~/.codex/agents/*.toml` for user scope;
- `<project>/.codex/agents/*.toml` for project scope.

The editor manages `name`, `description`, `developer_instructions`, nickname candidates, model, reasoning effort, sandbox mode, and `skills.config` entries. Assigned skill paths are absolute paths to the chosen runtime/scope installation and are enabled for the agent.

### 10.3 Safe editing

- Agent names and filenames use a validated slug and cannot contain path separators or traversal components.
- Parsers retain unknown supported fields so editing known fields does not erase advanced user configuration.
- Writes are atomic and create a timestamped backup before replacing an unmanaged existing file.
- Name collisions show the winning scope and require an explicit overwrite decision.
- Deleting an agent never deletes its skills.

### 10.4 Conversation selection

The composer offers `Default` plus compatible agents for the selected runtime. Selecting an agent can set its model and reasoning defaults, while the user may override them for the tab. The selected agent ID is stored with the tab and passed through the runtime-native mechanism.

## 11. Subagent Activity UI

The chat drawer gains a collapsible Subagents panel with `Active` and `Done` sections. Each node displays:

- parent-child indentation;
- nickname/name and role;
- runtime and model when known;
- queued/running/completed/failed/cancelled state;
- elapsed time;
- current tool/activity summary;
- final summary or error.

Selecting a node opens its inspectable details without switching the main conversation unexpectedly.

Codex recovery uses thread metadata, `parentThreadId`, thread status notifications, and thread reads/lists to reconstruct the tree after restart. Claude uses the Agent/Task tool lifecycle and included hook events available in its JSON stream. When Claude exposes only status and final result for a child, the UI shows exactly that level of detail and labels deeper transcript content as unavailable.

The panel does not display raw hidden reasoning. Reasoning summaries are shown only when supplied by the runtime as user-visible content.

## 12. User Experience

### 12.1 Environment setup

The current environment onboarding is changed from a Claude-only gate to an AI runtime gate:

- the workspace is ready when at least one runtime is authenticated;
- both Claude and Codex cards remain available after readiness;
- installation, authentication, version, account, and failure states are independent;
- existing OpenAI-compatible providers remain under the Claude-backed provider group and are not labeled Codex.

### 12.2 Composer

The provider/model selector becomes a runtime-aware selector:

1. Runtime or existing compatible provider.
2. Model.
3. Reasoning effort supported by that model.
4. Optional custom agent compatible with the runtime.

Changing runtime on a tab with an existing session starts a new session after confirmation; it never sends a Codex turn into a Claude session or vice versa.

### 12.3 Settings

Settings gains three focused areas:

- **AI Runtimes:** install, login, logout, version, and account state.
- **Skills:** catalog, import, runtime/scope destinations, enablement, managed ownership, and compatibility.
- **Agents:** library, scope, runtime, model, instructions, assigned skills, and validation.

## 13. Security and Failure Handling

- Credentials stay in each official runtime's credential store.
- Logs redact API keys, access tokens, authorization query values, and signed download URLs.
- No runtime is launched with a permission-bypass flag by default.
- Codex app-server requests use explicit approval/sandbox policies.
- Process cancellation is scoped by runtime, window, tab, and turn; closing one window does not kill unrelated Codex work.
- Stderr volume is bounded and retained separately from protocol stdout.
- JSON-RPC requests have method-appropriate timeouts and cancellation cleanup.
- Unsupported protocol features are surfaced with an upgrade message instead of silently emulated.
- Skill and agent filesystem operations validate canonical paths remain inside the selected destination.
- Existing user files are never recursively removed based only on a directory name.

## 14. Persistence and Migration

The frontend persisted chat schema gains a version number and migrates existing tabs as Claude tabs without changing their current session IDs or provider credential mappings. New fields include runtime, runtime model, reasoning effort, agent ID, and typed session reference.

Existing ClaudePrism authentication data is left in place. No Codex credential is added to it.

Project creation adds `AGENTS.md` only when Codex is selected as the initial runtime, or when the user explicitly enables Codex support in the project wizard, and the file does not already exist. It never overwrites existing `CLAUDE.md`, `AGENTS.md`, agent definitions, or skills.

## 15. Windows Packaging

The existing Tauri bundling continues to produce:

- NSIS `*-setup.exe` using the configured install mode;
- WiX MSI;
- updater artifacts when signing configuration is present.

The application installer contains ClaudePrism, not a pinned Claude or Codex CLI. First-run setup detects and offers the official installers for each runtime. Windows discovery specifically covers independent Codex CLI installs and the Codex desktop application's packaged CLI.

Release validation must fail when expected Windows artifacts are missing. The release workflow uses a frozen lockfile and checks that manifest versions match the release tag.

Authenticode verification is reported separately from Tauri updater signing. If no code-signing certificate is configured, tests may prove artifact integrity but must not claim the installer is Authenticode-signed.

## Delivery Decomposition

Implementation is split into four independently reviewable plans:

1. Runtime foundation: runtime-neutral domain types, Codex discovery and app-server lifecycle, authentication, model discovery, thread mapping, and dual-runtime chat.
2. Skills and agents: runtime-aware skill storage, safe custom-agent authoring, assigned-skill configuration, and migration from current Claude-only skill records.
3. Subagent activity and approvals: normalized Codex events, approval handling, parent/child activity UI, cancellation, and resumable state.
4. Regression and release: full Claude regression coverage, cross-platform checks, Windows NSIS/MSI builds, and clean-machine installer smoke tests.

Every plan must leave the application in a working and testable state. Passing an intermediate plan does not redefine completion: the feature is complete only after all acceptance criteria in this specification have current evidence.

## 16. Testing Strategy

Implementation follows test-driven development.

### 16.1 Baseline regression protection

Before changing production behavior, run and record:

- frontend Vitest suite;
- TypeScript/Vite build;
- Biome check;
- Rust unit and integration tests;
- Rust format and Clippy checks where the installed toolchain permits them.

Existing failures are reported before implementation rather than attributed to the feature.

### 16.2 Rust tests

- Codex path discovery across Windows and Unix candidate layouts.
- Version and login-status parsing.
- JSON-RPC request correlation with interleaved responses, notifications, and server requests.
- Initialize, account, login, model pagination, thread, turn, interrupt, and restart transcripts.
- Unknown notification/item compatibility.
- Normalized event mapping and idempotent item merging.
- Agent parser/writer round trips with unknown field preservation.
- Skill frontmatter validation, manifest ownership, safe copy/update/delete, and path traversal rejection.
- Process registry isolation across windows, tabs, and runtimes.

Protocol tests use deterministic fake app-server transcripts and never require a real account.

### 16.3 Frontend tests

- Independent Claude and Codex account states.
- At-least-one-runtime onboarding gate.
- Per-tab runtime/model/effort/agent persistence and migration of existing tabs.
- Correct command routing for new, resumed, interrupted, and failed turns.
- Runtime/model capability selectors.
- Skills destination, compatibility, ownership, and assignment UI.
- Agent create/edit/delete validation.
- Subagent tree updates, out-of-order events, restart restoration, and error display.
- Existing Claude setup, provider switching, sessions, multi-tab, project, and proposed-change tests.

### 16.4 Integration tests

- A fake Codex app-server child process exercises the full Tauri bridge.
- An opt-in real Codex test verifies account read, model list, thread start, a harmless turn, and interrupt without exposing credentials in CI logs.
- Runtime skill verification confirms a managed skill appears in Codex `skills/list`.
- Runtime agent verification starts a custom child agent that reports the assigned skill name from its visible skill context.

### 16.5 Windows installer tests

On a clean Windows 11 environment, cover:

1. Claude-only installation and login.
2. Codex-only installation and login.
3. Independent Codex CLI and Codex desktop packaged CLI discovery.
4. Claude and Codex simultaneously authenticated.
5. Concurrent turns, independent cancel, and session resume.
6. Skill import and custom-agent assignment in both runtimes.
7. Visible subagent start, completion, and failure.
8. NSIS silent install/start/upgrade/uninstall.
9. MSI silent install/uninstall.
10. Upgrade from the prior release without losing projects, sessions, authentication, or unmanaged skills.

## 17. Acceptance Criteria

The feature is complete only when all of the following have current evidence:

1. Claude and Codex independently report installed and authenticated states in the same application session.
2. Both runtimes can send a prompt, stream a result, cancel a turn, and resume their own session without cross-routing.
3. Codex model choices originate from `model/list`, and selected model/reasoning values reach thread or turn configuration.
4. A skill imported for Claude, Codex, or both is discoverable by the selected target runtime.
5. A Claude custom agent and a Codex custom agent can each be saved with assigned skills in native format.
6. A real child-agent run demonstrates that an assigned skill is visible to that child.
7. Active, completed, failed, and cancelled child runs appear in the Subagents panel with correct parent relationships.
8. Existing Claude and OpenAI-compatible behavior passes its full regression suite.
9. Frontend tests, Rust tests, lint, type/build checks, and the Tauri Windows build finish successfully.
10. The expected Windows NSIS and MSI artifacts exist and pass the documented installation smoke tests.
11. Upgrade testing demonstrates that existing projects, Claude sessions, provider credentials, history, and unmanaged skills remain intact.
12. A separate read-only Codex task reviews the completed candidate across requirement completeness, logical correctness, boundary cases, code quality, test coverage, and actual runtime results; all blocking findings are repaired and re-reviewed until it returns an evidence-backed approval.

## 18. Independent Completion Review

After implementation and all internal acceptance gates are complete, ClaudePrism's main implementation task creates a separate Codex task as a strict reviewer. The reviewer receives the approved specification, implementation plans, candidate commit, source diff, automated results, real-runtime evidence, and Windows installer evidence. It may inspect and run diagnostics but must not edit, stage, commit, reset, or delete source files.

The reviewer evaluates six dimensions independently:

1. requirement completeness;
2. logical correctness;
3. boundary and failure cases;
4. code quality and maintainability;
5. test coverage and whether tests prove the claims;
6. actual runtime and installer results.

A changes-required verdict must include an ordered, evidence-backed repair checklist. The main task reproduces each issue, repairs it with tests, reruns affected and full verification, and returns the new candidate to the same review task for a complete re-review. This loop continues without an iteration limit until the reviewer returns an evidence-backed approval with no unresolved blocking finding. The active goal cannot be marked complete before that approval and its review/repair history are recorded.

## 19. Authoritative References

- Codex app-server protocol: <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- Codex custom agents and subagents: <https://developers.openai.com/codex/subagents>
- Codex skills: <https://developers.openai.com/codex/skills>
- Codex CLI installation: <https://github.com/openai/codex/blob/main/README.md>
- Claude custom subagents: <https://code.claude.com/docs/en/sub-agents>
- Claude skills: <https://code.claude.com/docs/en/skills>
