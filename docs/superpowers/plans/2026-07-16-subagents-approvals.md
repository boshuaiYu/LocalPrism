# Subagent Activity and Runtime Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize runtime events, guarantee every Codex server request is resolved, and show recoverable Claude/Codex child-agent activity with correct parent relationships.

**Architecture:** Extend the shared event envelope from plan 1 with idempotent backend reducers, a pending server-request registry, and a runtime-neutral agent-run cache. The frontend accepts only validated normalized events, keeps approvals and agent runs in focused stores, and renders visible Active/Done subagent trees without exposing hidden reasoning.

**Tech Stack:** Rust, Tokio, Serde JSON, Tauri events, Codex app-server v2 server requests/notifications, React, Zustand, Vitest, React Testing Library.

---

**Program position:** Plan 3 of 4. Requires both runtime foundation and skills/agents. This phase supplies the real child-agent assigned-skill evidence required by the approved specification.

## File map

**Create**

- `apps/desktop/src-tauri/src/runtime/agent_runs.rs` - backend run cache, hierarchy, and recovery merge.
- `apps/desktop/src-tauri/src/runtime/codex/approvals.rs` - pending server-request registry and typed responses.
- `apps/desktop/src/runtime/event-normalizer.ts` - defensive wire validation and sequence/item reduction.
- `apps/desktop/src/hooks/use-runtime-events.ts` - one shared Tauri event subscription.
- `apps/desktop/src/stores/approval-store.ts` - pending request state and exactly-once response actions.
- `apps/desktop/src/stores/agent-run-store.ts` - per-conversation hierarchy and details state.
- `apps/desktop/src/components/approvals/approval-dialog.tsx` - command/file/permission/user-input UI.
- `apps/desktop/src/components/subagents/subagent-panel.tsx` - collapsible Active/Done panel.
- `apps/desktop/src/components/subagents/subagent-tree.tsx` - recursive parent/child display.
- `apps/desktop/src/components/subagents/subagent-details.tsx` - inspectable activity/result/error.
- `apps/desktop/src/__tests__/runtime/event-normalizer.test.ts`
- `apps/desktop/src/__tests__/stores/approval-store.test.ts`
- `apps/desktop/src/__tests__/stores/agent-run-store.test.ts`
- `apps/desktop/src/__tests__/components/subagent-panel.test.tsx`
- `apps/desktop/src-tauri/tests/fixtures/codex-events.jsonl` - scrubbed v2 lifecycle transcript.
- `apps/desktop/src-tauri/tests/fixtures/claude-agent-events.jsonl` - scrubbed Claude Agent/Task lifecycle transcript.

**Modify**

- `apps/desktop/src-tauri/src/runtime/mod.rs` - register request/run commands and state.
- `apps/desktop/src-tauri/src/runtime/events.rs` - concrete payload fields for every predeclared event variant.
- `apps/desktop/src-tauri/src/runtime/claude.rs` - convert Claude Agent/Task lifecycle while retaining legacy events.
- `apps/desktop/src-tauri/src/runtime/codex/rpc.rs` - route and resolve server-initiated requests.
- `apps/desktop/src-tauri/src/runtime/codex/app_server.rs` - own approvals/run recovery and send `initialized` after handshake.
- `apps/desktop/src-tauri/src/runtime/codex/event_mapper.rs` - authoritative item/turn/subagent mapping.
- `apps/desktop/src-tauri/src/runtime/codex/protocol.rs` - narrow notification/request/response structs.
- `apps/desktop/src-tauri/src/claude_process.rs:133-307` - dual-emit normalized Claude lifecycle and scoped cancellation.
- `apps/desktop/src-tauri/src/lib.rs:568-649,706-718` - managed states, commands, cleanup.
- `apps/desktop/src/runtime/types.ts` - finalize runtime event, request, agent-run, and tree types.
- `apps/desktop/src/__tests__/mocks/tauri.ts:35-45` - controllable event listener mock.
- `apps/desktop/src/components/claude-chat/claude-chat-drawer.tsx` - mount shared events, approval dialog, and Subagents panel.
- `apps/desktop/src/components/claude-chat/chat-messages.tsx` - render normalized visible summaries only.
- `apps/desktop/src/components/claude-chat/tool-widgets.tsx` - normalized tools and compatibility widgets.
- `apps/desktop/package.json` and `pnpm-lock.yaml` - component testing dependencies.

### Task 1: Make normalized runtime events concrete and defensively validated

**Files:**

- Modify: `apps/desktop/src-tauri/src/runtime/events.rs`
- Modify: `apps/desktop/src/runtime/types.ts`
- Create: `apps/desktop/src/runtime/event-normalizer.ts`
- Create: `apps/desktop/src/__tests__/runtime/event-normalizer.test.ts`

- [ ] **Step 1: Write frontend envelope validation tests**

Cover valid Claude/Codex envelopes, missing runtime/tab/sequence, non-monotonic sequences, unknown event types, duplicated item completion, and a completed item replacing its accumulated deltas.

```ts
expect(normalizeRuntimeEnvelope(validCodexDelta).ok).toBe(true);
expect(normalizeRuntimeEnvelope({ ...validCodexDelta, tabId: "" }).ok).toBe(false);
expect(reducer.apply(completed).items["item-1"]?.text).toBe("authoritative text");
```

- [ ] **Step 2: Run the tests and verify failure**

Run:

```powershell
corepack pnpm --filter @claude-prism/desktop test -- event-normalizer
```

Expected: FAIL because the normalizer does not exist.

- [ ] **Step 3: Finalize the event payload contract in Rust and TypeScript**

All item lifecycle payloads include `itemId`. Approval/user-input events include `requestId`, `method`, `runtime`, `threadId`, `turnId`, optional `agentRunId`, safe display fields, and a redacted native payload. Subagent events use:

```ts
export interface AgentRun {
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
  activity: string | null;
  summary: string | null;
  error: string | null;
  transcriptAvailable: boolean;
}

export interface RuntimeRequest {
  requestId: number | string;
  method: string;
  runtime: RuntimeKind;
  threadId: string | null;
  turnId: string | null;
  tabId: string;
  agentRunId: string | null;
  title: string;
  command: string | null;
  cwd: string | null;
  diff: string | null;
  permissions: Record<string, unknown> | null;
  questions: Array<{ id: string; prompt: string; options: string[] }>;
}

export interface RuntimeRequestResponse {
  decision: "allow" | "allowForSession" | "deny" | "cancel" | "unsupported";
  persistence: "turn" | "session" | null;
  answers: Record<string, string[]>;
}
```

Add the matching Rust `AgentRun` in `runtime/events.rs` with camelCase serialization and the same fields/status values; `RuntimeEvent::SubagentDiscovered` and `SubagentStatusChanged` carry that type rather than an untyped JSON value.

- [ ] **Step 4: Implement defensive normalization**

`normalizeRuntimeEnvelope(value)` returns `{ok:true,value}` or `{ok:false,error}` and never throws. Unknown variants become a visible `warning` event carrying the native method/type but not arbitrary secret-bearing payloads. `RuntimeEventReducer` keys items by `<runtime>:<sessionId>:<itemId>`, ignores an older sequence, appends deltas once, and replaces delta text with `item/completed` content.

- [ ] **Step 5: Run tests and commit**

```powershell
corepack pnpm --filter @claude-prism/desktop test -- event-normalizer
git add apps/desktop/src-tauri/src/runtime/events.rs apps/desktop/src/runtime/event-normalizer.ts apps/desktop/src/__tests__/runtime/event-normalizer.test.ts
git commit -m "feat: validate normalized runtime events"
```

### Task 2: Map Codex lifecycle and child-agent events idempotently

**Files:**

- Create: `apps/desktop/src-tauri/tests/fixtures/codex-events.jsonl`
- Modify: `apps/desktop/src-tauri/src/runtime/codex/protocol.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/codex/event_mapper.rs`
- Create: `apps/desktop/src-tauri/src/runtime/agent_runs.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/mod.rs`

- [ ] **Step 1: Write a scrubbed transcript fixture**

Include `thread/started`, `turn/started`, `item/started` and `item/completed` for `agentMessage`, `commandExecution`, `fileChange`, and `collabAgentToolCall`, plus `thread/status/changed`, `turn/completed`, duplicate completion, and out-of-order delta. The collab item includes `senderThreadId`, `receiverThreadIds`, `tool:"spawnAgent"`, `agentsStates`, model, reasoning effort, prompt, and final state.

- [ ] **Step 2: Write mapper/reducer tests**

Assert one assistant message, authoritative command result, one child per receiver thread, correct parent from sender thread, status mapping (`pendingInit` to queued, `running` to running, `completed` to completed, `errored` to failed, `interrupted`/`shutdown` to cancelled), and no duplicate child after replay.

- [ ] **Step 3: Run mapper tests and verify failure**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml runtime::codex::event_mapper --lib
```

Expected: FAIL on collab mapping and idempotency.

- [ ] **Step 4: Implement authoritative lifecycle reduction**

`CodexEventMapper` stores item state by `(thread_id,item_id)`. Deltas affect rendering only while an item is in progress. `item/completed` overwrites aggregate result/status. `turn/completed` determines terminal turn state; a process crash maps to failed, never completed.

- [ ] **Step 5: Implement the backend run cache**

```rust
#[derive(Default)]
pub struct AgentRunState {
    runs: tokio::sync::RwLock<std::collections::HashMap<String, AgentRun>>,
}

impl AgentRunState {
    pub async fn apply(&self, run: AgentRun) -> AgentRun;
    pub async fn list_for_root(&self, runtime: RuntimeKind, root: &str) -> Vec<AgentRun>;
    pub async fn replace_recovered(&self, runtime: RuntimeKind, root: &str, runs: Vec<AgentRun>);
}
```

Merge terminal states monotonically and permit parent arrival after child arrival. Never persist raw hidden reasoning.

- [ ] **Step 6: Run tests and commit**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml runtime::codex::event_mapper --lib
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml runtime::agent_runs --lib
git add apps/desktop/src-tauri/src/runtime apps/desktop/src-tauri/tests/fixtures/codex-events.jsonl
git commit -m "feat: map Codex tools and child agents"
```

### Task 3: Resolve every app-server request exactly once

**Files:**

- Create: `apps/desktop/src-tauri/src/runtime/codex/approvals.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/codex/rpc.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/codex/app_server.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/codex/protocol.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/mod.rs`

- [ ] **Step 1: Write pending-request tests**

Cover command approval, file approval, permission request, tool user input, duplicate response, timeout, app-server exit, tab cancellation, and an unknown method. Assert every request receives one and only one result/error frame and pending count returns to zero.

- [ ] **Step 2: Run approval tests and verify failure**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml runtime::codex::approvals --lib
```

Expected: FAIL because no registry exists.

- [ ] **Step 3: Implement pending request state**

```rust
pub struct PendingRuntimeRequest {
    pub id: RpcId,
    pub method: String,
    pub window_label: String,
    pub tab_id: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub created_at: std::time::Instant,
    pub payload: serde_json::Value,
}

#[derive(Default)]
pub struct ApprovalState {
    pending: tokio::sync::Mutex<std::collections::HashMap<RpcId, PendingRuntimeRequest>>,
}
```

Register before emitting to React. Remove atomically before sending a response so double clicks cannot reply twice.

- [ ] **Step 4: Implement typed response mapping**

For `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`, map allow/allow-for-session/deny/cancel to `accept`/`acceptForSession`/`decline`/`cancel`. For `item/permissions/requestApproval`, allow returns the displayed granted permission object and `scope` (`turn` or `session`); deny returns an empty permission profile with turn scope; cancel returns the empty profile and interrupts the turn. For `item/tool/requestUserInput`, return `{answers:{questionId:{answers:["answer"]}}}` with actual collected strings. Unsupported methods receive JSON-RPC error `-32601` with a redacted method name.

- [ ] **Step 5: Add the Tauri response command**

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeRequestDecision {
    Allow,
    AllowForSession,
    Deny,
    Cancel,
    Unsupported,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveRuntimeRequest {
    pub request_id: RpcId,
    pub decision: RuntimeRequestDecision,
    pub persistence: Option<String>,
    pub answers: std::collections::HashMap<String, Vec<String>>,
}

#[tauri::command]
pub async fn runtime_request_respond(
    request: ResolveRuntimeRequest,
    approvals: tauri::State<'_, ApprovalState>,
    codex: tauri::State<'_, CodexAppServerState>,
) -> Result<(), String>;
```

- [ ] **Step 6: Make phase-1 fallback safe**

Before the React listener reports ready, known approval requests receive `decline` and unknown methods receive `-32601`; emit a visible warning. After listener readiness, use a 10-minute approval timeout. Closing a tab/window, interrupting a turn, or losing app-server resolves all matching pending requests with cancel/error.

- [ ] **Step 7: Complete the handshake correctly**

After the successful `initialize` response, send the app-server `initialized` notification before account/model/thread requests. The app-server wire does not require a `jsonrpc` field; accept frames with or without it.

- [ ] **Step 8: Run tests and commit**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml runtime::codex::approvals --lib
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml runtime::codex::rpc --lib
git add apps/desktop/src-tauri/src/runtime/codex apps/desktop/src-tauri/src/runtime/mod.rs
git commit -m "feat: handle Codex approvals and user input"
```

### Task 4: Add the frontend approval store and dialog

**Files:**

- Create: `apps/desktop/src/stores/approval-store.ts`
- Create: `apps/desktop/src/components/approvals/approval-dialog.tsx`
- Create: `apps/desktop/src/__tests__/stores/approval-store.test.ts`
- Modify: `apps/desktop/src/hooks/use-runtime-events.ts`
- Modify: `apps/desktop/src/components/claude-chat/claude-chat-drawer.tsx`

- [ ] **Step 1: Write exactly-once store tests**

Queue two requests for different tabs, respond to one, double-submit it, cancel the second by turn, and feed an unknown request. Assert one `runtime_request_respond` call per known ID and an immediate `unsupported` response for the unknown method.

- [ ] **Step 2: Run the tests and verify failure**

Run:

```powershell
corepack pnpm --filter @claude-prism/desktop test -- approval-store
```

Expected: FAIL because the store is missing.

- [ ] **Step 3: Implement the approval state**

```ts
interface ApprovalStoreState {
  pending: Record<string, RuntimeRequest>;
  enqueue(request: RuntimeRequest): void;
  respond(requestId: string, response: RuntimeRequestResponse): Promise<void>;
  cancelForTurn(runtime: RuntimeKind, threadId: string, turnId: string): Promise<void>;
  rejectUnknown(request: RuntimeRequest): Promise<void>;
}
```

`RuntimeRequest.requestId` is `number | string`; derive the record key with this helper and pass the original ID back to Tauri:

```ts
export const requestKey = (id: number | string) =>
  typeof id === "number" ? `n:${id}` : `s:${id}`;
```

Move a request to an in-flight set before `invoke`; restore it only if sending fails and the backend still reports it pending.

- [ ] **Step 4: Implement the dialog**

Show source runtime, thread, selected agent, command/cwd or file diff, requested permissions, and persistence scope. Command/file decisions are Allow once, Allow for session, Deny, Cancel turn. Permission requests show the exact filesystem/network grant. User input renders every question and sends all answers together. Escape/close maps to deny, not silent dismissal.

- [ ] **Step 5: Wire shared events**

`useRuntimeEvents` owns one `listen("runtime-event")`. It validates the envelope, routes approval/user-input events to this store, messages/tools to chat state, and subagent events to the agent-run store. Do not send Codex request answers through `sendPrompt`.

- [ ] **Step 6: Run tests/build and commit**

```powershell
corepack pnpm --filter @claude-prism/desktop test -- approval-store event-normalizer
corepack pnpm --filter @claude-prism/desktop build
git add apps/desktop/src/stores/approval-store.ts apps/desktop/src/components/approvals apps/desktop/src/hooks/use-runtime-events.ts apps/desktop/src/components/claude-chat/claude-chat-drawer.tsx apps/desktop/src/__tests__/stores/approval-store.test.ts
git commit -m "feat: add runtime approval dialogs"
```

### Task 5: Add a recoverable frontend agent-run tree

**Files:**

- Create: `apps/desktop/src/stores/agent-run-store.ts`
- Create: `apps/desktop/src/components/subagents/subagent-panel.tsx`
- Create: `apps/desktop/src/components/subagents/subagent-tree.tsx`
- Create: `apps/desktop/src/components/subagents/subagent-details.tsx`
- Create: `apps/desktop/src/__tests__/stores/agent-run-store.test.ts`
- Create: `apps/desktop/src/__tests__/components/subagent-panel.test.tsx`
- Modify: `apps/desktop/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/desktop/src/__tests__/mocks/tauri.ts:35-45`

- [ ] **Step 1: Add component test dependencies**

Run:

```powershell
corepack pnpm --filter @claude-prism/desktop add -D @testing-library/react @testing-library/user-event @testing-library/jest-dom
```

Expected: desktop package and lockfile change; no production dependency added.

- [ ] **Step 2: Extend the Tauri event mock**

Store listeners by event name and export `emitMockTauriEvent(name,payload)` plus `resetMockTauriEvents()`. Existing tests still receive a resolved unlisten function.

- [ ] **Step 3: Write reducer tests**

Cover child before parent, duplicate discovery, queued-running-terminal transitions, terminal monotonicity, failure/cancel, recovery merge, two roots with the same child nickname, and selection/details that do not alter the main conversation.

- [ ] **Step 4: Write component tests**

Render Active and Done sections, nested indentation, runtime/model badges, elapsed time, current activity, summary/error, and `Transcript unavailable` for a Claude child lacking transcript access. Clicking a child opens details without invoking session switching.

- [ ] **Step 5: Run the tests and verify failure**

Run:

```powershell
corepack pnpm --filter @claude-prism/desktop test -- agent-run-store subagent-panel
```

Expected: FAIL because store/components are missing.

- [ ] **Step 6: Implement the store**

```ts
interface AgentRunStoreState {
  runsByRoot: Record<string, Record<string, AgentRun>>;
  selectedRunId: string | null;
  applyEvent(root: ConversationRef, event: RuntimeEvent): void;
  restore(root: ConversationRef): Promise<void>;
  selectRun(id: string | null): void;
  tree(root: ConversationRef): AgentRunNode[];
}

interface AgentRunNode extends AgentRun {
  children: AgentRunNode[];
}
```

Tree construction is pure, tolerates missing parents, and sorts running first then start time. Do not store raw reasoning.

- [ ] **Step 7: Implement the panel and details**

The drawer panel is collapsible, defaults open while a child is active, groups Active (`queued`, `running`) and Done (`completed`, `failed`, `cancelled`), and never switches the main tab. Details display only runtime-exposed messages/results.

- [ ] **Step 8: Run tests/build and commit**

```powershell
corepack pnpm --filter @claude-prism/desktop test -- agent-run-store subagent-panel
corepack pnpm --filter @claude-prism/desktop build
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src/__tests__/mocks/tauri.ts apps/desktop/src/stores/agent-run-store.ts apps/desktop/src/components/subagents apps/desktop/src/__tests__/stores/agent-run-store.test.ts apps/desktop/src/__tests__/components/subagent-panel.test.tsx
git commit -m "feat: show subagent activity tree"
```

### Task 6: Map Claude Agent/Task activity without breaking raw Claude events

**Files:**

- Create: `apps/desktop/src-tauri/tests/fixtures/claude-agent-events.jsonl`
- Modify: `apps/desktop/src-tauri/src/runtime/claude.rs`
- Modify: `apps/desktop/src-tauri/src/claude_process.rs:133-307`
- Modify: `apps/desktop/src/hooks/use-claude-events.ts`

- [ ] **Step 1: Write a scrubbed Claude lifecycle fixture and tests**

Include Agent/Task tool start, progress/status where available, final result, failure, and cancellation. Assert stable run IDs, parent root, exact available activity, and `transcriptAvailable=false` where Claude exposes no child transcript.

- [ ] **Step 2: Run Claude mapper tests and verify failure**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml runtime::claude --lib
```

Expected: FAIL on child-agent mapping.

- [ ] **Step 3: Implement dual emission during migration**

Continue emitting `claude-output`, `claude-complete`, and `claude-error` exactly as current consumers expect. Additionally parse tool lifecycle into normalized runtime events. Do not infer a transcript, nickname, model, or status that is absent; use null/unavailable fields.

- [ ] **Step 4: Remove the unconditional Claude permission bypass**

At the current `common_claude_args` implementation, remove `--dangerously-skip-permissions`. Pass the selected explicit Claude permission mode through the compatibility adapter. Add an argument-building test proving the bypass flag is absent by default.

- [ ] **Step 5: Run Claude regressions and commit**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml runtime::claude --lib
corepack pnpm --filter @claude-prism/desktop test -- claude-chat-send-prompt claude-chat-store
git add apps/desktop/src-tauri/src/runtime/claude.rs apps/desktop/src-tauri/src/claude_process.rs apps/desktop/src-tauri/tests/fixtures/claude-agent-events.jsonl apps/desktop/src/hooks/use-claude-events.ts
git commit -m "feat: normalize Claude child-agent activity"
```

### Task 7: Recover Codex child trees after restart and resume

**Files:**

- Modify: `apps/desktop/src-tauri/src/runtime/codex/app_server.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/codex/protocol.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/codex/event_mapper.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/agent_runs.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/mod.rs`
- Modify: `apps/desktop/src/stores/agent-run-store.ts`

- [ ] **Step 1: Write recovery tests**

Fixture pages contain root, child, and grandchild threads with `parentThreadId`, `ancestorThreadId`, source kind, status, timestamps, name/nickname, and model. Assert pagination, ancestry, status conversion, duplicate merge with live events, and no unrelated project/root leakage.

- [ ] **Step 2: Run recovery tests and verify failure**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml recover_agent_runs --lib
```

Expected: FAIL because recovery is missing.

- [ ] **Step 3: Implement paginated recovery**

On app-server restart and `runtime_agent_runs` request, page `thread/list` for the project, retain descendants whose ancestor/root matches the requested conversation, and call `thread/read` only when display details are absent. `ancestorThreadId` and experimental fields are used only after `experimentalApi:true` negotiation; fall back to parent walking when absent.

- [ ] **Step 4: Add the list command**

```rust
#[tauri::command]
pub async fn runtime_agent_runs(
    runtime: RuntimeKind,
    root_conversation_id: String,
    project_path: String,
    state: tauri::State<'_, AgentRunState>,
    codex: tauri::State<'_, CodexAppServerState>,
) -> Result<Vec<AgentRun>, String>;
```

Claude returns its in-memory observed runs; Codex merges recovery and live cache.

- [ ] **Step 5: Run recovery/store tests and commit**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml recover_agent_runs --lib
corepack pnpm --filter @claude-prism/desktop test -- agent-run-store
git add apps/desktop/src-tauri/src/runtime apps/desktop/src/stores/agent-run-store.ts
git commit -m "feat: recover Codex subagent trees"
```

### Task 8: Prove assigned skills reach a real child agent and close the phase

**Files:**

- Modify: `apps/desktop/src/components/claude-chat/claude-chat-drawer.tsx`
- Modify: `apps/desktop/src/components/claude-chat/chat-messages.tsx`
- Modify: `apps/desktop/src/components/claude-chat/tool-widgets.tsx`
- Create during execution: `docs/release/evidence/dual-runtime-child-agent.json`

- [ ] **Step 1: Add final presentation tests**

Test assistant messages, user-visible reasoning summaries, command/file widgets, approvals, active/completed/failed/cancelled children, hierarchy, details, and unknown warnings. Assert raw reasoning text is never rendered from an unknown/native payload.

- [ ] **Step 2: Run the complete automated gate**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
corepack pnpm --filter @claude-prism/desktop test
corepack pnpm exec biome check
corepack pnpm --filter @claude-prism/desktop build
```

Expected: all commands exit `0`.

- [ ] **Step 3: Perform the real Codex child-agent visibility check**

Create a harmless test skill whose instruction requires the child to return a fixed nonce plus its resolved `SKILL.md` path. Install it for Codex, assign it to a Codex custom agent, start a root Codex turn that spawns that role, and verify: the child returns the nonce/path; Active then Done states appear; parent/child IDs match app-server metadata; completion survives app restart/recovery.

- [ ] **Step 4: Perform the real Claude child-agent visibility check**

Install the equivalent Claude skill, assign it in a Claude agent's native `skills` list, run the child, and verify the nonce/path and the exact detail level Claude exposes. Do not claim transcript availability when the runtime supplies only status/result.

- [ ] **Step 5: Record scrubbed evidence**

Write `dual-runtime-child-agent.json` with runtime, app/CLI versions, root ID hash, child ID hash, parent relationship, assigned skill name/path hash, observed nonce, state transitions, and test timestamp. Exclude prompts, credentials, account identifiers, and raw hidden reasoning.

- [ ] **Step 6: Commit the phase**

```powershell
git add apps/desktop/src apps/desktop/src-tauri/src apps/desktop/src-tauri/tests docs/release/evidence/dual-runtime-child-agent.json apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat: complete approvals and visible subagents"
```

## Phase exit evidence

- Every supported or unsupported app-server request receives exactly one terminal response.
- Normalized items are idempotent and completed results are authoritative.
- Active, completed, failed, and cancelled child runs display with correct parent relationships.
- Codex child trees recover after restart; Claude exposes only runtime-available detail.
- Real Claude and Codex child runs prove assigned-skill visibility without exposing credentials or hidden reasoning.
