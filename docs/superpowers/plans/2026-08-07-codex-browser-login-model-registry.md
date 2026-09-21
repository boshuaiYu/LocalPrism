# Codex Browser Login and Model Registry Implementation Plan

**Status:** SUPERSEDED by [2026-09-17 Single-Provider Runtime Design](../specs/2026-09-17-single-provider-runtime-design.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ChatGPT browser-subscription login race-safe and recoverable, then expose account-returned OpenAI models with cache and bundled-registry fallback so a user can complete and resume a real Codex conversation.

**Architecture:** Keep `codex app-server` as the sole credential owner. Add a bounded login state machine around its existing JSON-RPC methods and a source-ordered model catalog resolver: non-empty live `model/list`, then official disk cache, then an independently defined bundled registry whose catalog keys map explicitly to wire model IDs.

**Tech Stack:** Tauri 2, Rust, Tokio, serde, React, TypeScript, Zustand, Vitest, Testing Library, pnpm, Cargo.

---

## Dirty-worktree safety

This checkout already contains overlapping uncommitted Codex/runtime work. Do not run broad `git add`, `git commit -a`, stash, reset, checkout, clean, or recursive deletion commands. At every checkpoint, inspect only the named paths. Leave implementation changes unstaged unless the user separately approves a consolidated commit. New files may be staged only after verifying they do not depend on uncommitted files for standalone correctness.

## File structure

- Create `apps/desktop/src-tauri/src/runtime/codex/model_registry.rs`: versioned bundled fallback entries and catalog-key-to-wire-ID conversion.
- Create `apps/desktop/src-tauri/src/runtime/codex/model_catalog.rs`: pure live/cache/registry precedence, de-duplication, and metadata enrichment.
- Modify `apps/desktop/src-tauri/src/runtime/codex/mod.rs`: bounded login start, stale-attempt cleanup, and catalog resolver integration.
- Modify `apps/desktop/src-tauri/src/runtime/codex/models_cache.rs`: expose cache parsing to the resolver without merging cache-only models into a live list.
- Modify `apps/desktop/src-tauri/src/runtime/mod.rs`: optional-login-ID cancellation and catalog response types/commands.
- Modify `apps/desktop/src/runtime/types.ts`: frontend login states and model catalog/source types.
- Modify `apps/desktop/src/runtime/commands.ts`: optional login cancellation and catalog response validation.
- Modify `apps/desktop/src/stores/runtime-store.ts`: starting/verifying states, ten-minute authorization bound, current-attempt cancellation, catalog source storage, and one-shot post-login refresh.
- Modify `apps/desktop/src/components/runtime/runtime-card.tsx`: starting/verifying/reopen/cancel presentation.
- Modify `apps/desktop/src/components/runtime/runtime-selector.tsx`: fallback source notice and unavailable-model presentation.
- Modify `apps/desktop/src/components/claude-chat/chat-composer.tsx`: valid default selection and unavailable persisted-model blocking.
- Modify `apps/desktop/src/stores/claude-chat-store.ts`: validate Codex model/effort before send and refresh after a server-side model rejection.
- Modify focused Rust and frontend test files listed below.

### Task 1: Bound and cancel browser-login attempts in Rust

**Files:**
- Modify: `apps/desktop/src-tauri/src/runtime/codex/mod.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/mod.rs`
- Test: inline `#[cfg(test)]` modules in both files

- [ ] **Step 1: Add failing tests for a hung start and pre-ID cancellation**

Add a bounded helper test beside the existing account/login tests:

```rust
#[tokio::test]
async fn account_and_models_browser_login_start_has_an_outer_timeout() {
    let error = start_login_with_request_bounded(
        RuntimeLoginMode::Browser,
        None,
        Duration::from_millis(10),
        |_method, _params| async {
            std::future::pending::<Result<Value, String>>().await
        },
    )
    .await
    .unwrap_err();

    assert_eq!(error, "Codex login start timed out");
}

#[test]
fn account_and_models_clearing_a_pending_login_invalidates_its_late_response() {
    let state = CodexAppServerState::default();
    let attempt = state.begin_login_attempt();
    state.clear_active_login();

    let error = state
        .finish_login_attempt(attempt, "late-login".into())
        .unwrap_err();
    assert!(error.contains("superseded"));
    assert_eq!(state.active_login_id(), None);
}
```

Add validation coverage in `runtime/mod.rs` for cancellation without a server login ID:

```rust
#[test]
fn account_and_models_cancel_accepts_none_only_for_local_pending_login() {
    assert_eq!(normalize_codex_cancel_login(RuntimeKind::Codex, None).unwrap(), None);
    assert!(normalize_codex_cancel_login(RuntimeKind::Claude, None).is_err());
    assert!(normalize_codex_cancel_login(RuntimeKind::Codex, Some("   ".into())).is_err());
}
```

- [ ] **Step 2: Run the focused Rust tests and verify RED**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline account_and_models_browser_login_start_has_an_outer_timeout -- --nocapture
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline account_and_models_cancel_accepts_none_only_for_local_pending_login -- --nocapture
```

Expected: FAIL because `start_login_with_request_bounded` and `normalize_codex_cancel_login` do not exist.

- [ ] **Step 3: Implement the bounded helper and use it from `login_start`**

In `runtime/codex/mod.rs`, add:

```rust
const LOGIN_START_TIMEOUT: Duration = Duration::from_secs(60);

async fn start_login_with_request_bounded<F, Fut>(
    mode: RuntimeLoginMode,
    api_key: Option<String>,
    timeout: Duration,
    request: F,
) -> Result<LoginStartOutcome, String>
where
    F: FnMut(&'static str, Value) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
{
    tokio::time::timeout(
        timeout,
        start_login_with_request(mode, api_key, request),
    )
    .await
    .map_err(|_| "Codex login start timed out".to_string())?
}
```

Replace the direct `start_login_with_request(...)` call inside `login_start` with this helper and `LOGIN_START_TIMEOUT`. On every error or timeout, call `state.abandon_login_attempt(attempt)` before returning. If `finish_login_attempt` rejects a response as stale and the response contains a `login_id`, send best-effort `account/login/cancel` for that exact ID before returning the superseded error; never cancel the current attempt by generation alone.

- [ ] **Step 4: Accept optional cancellation IDs at the Tauri boundary**

In `runtime/mod.rs`, add:

```rust
fn normalize_codex_cancel_login(
    runtime: RuntimeKind,
    login_id: Option<String>,
) -> Result<Option<String>, String> {
    if runtime != RuntimeKind::Codex {
        return Err("This login command is only available for the Codex runtime".into());
    }
    match login_id {
        Some(login_id) if login_id.trim().is_empty() => {
            Err("A login ID is required to cancel an active Codex login".into())
        }
        Some(login_id) => Ok(Some(login_id)),
        None => Ok(None),
    }
}
```

Change `runtime_login_cancel` to accept `login_id: Option<String>`. For `None`, call `codex_state.clear_active_login()` and return `Ok(())`. For a matching `Some(login_id)`, retain the existing `account/login/cancel` request. A stale non-matching ID remains an idempotent `Ok(())`.

- [ ] **Step 5: Run focused login tests and inspect only the overlapping diff**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline account_and_models_ -- --test-threads=1
git diff --check -- apps/desktop/src-tauri/src/runtime/codex/mod.rs apps/desktop/src-tauri/src/runtime/mod.rs
git diff -- apps/desktop/src-tauri/src/runtime/codex/mod.rs apps/desktop/src-tauri/src/runtime/mod.rs
```

Expected: focused tests PASS; diff contains the new bounded/cancellation behavior plus preserved pre-existing WIP. Do not stage these dirty files.

### Task 2: Add frontend starting/verifying/cancelled login behavior

**Files:**
- Modify: `apps/desktop/src/runtime/types.ts`
- Modify: `apps/desktop/src/runtime/commands.ts`
- Modify: `apps/desktop/src/stores/runtime-store.ts`
- Test: `apps/desktop/src/__tests__/runtime/commands.test.ts`
- Test: `apps/desktop/src/__tests__/stores/runtime-store.test.ts`

- [ ] **Step 1: Add RED command and store tests**

In `commands.test.ts`, add:

```ts
it("cancels a pending Codex login before a login id exists", async () => {
  invokeMock.mockResolvedValue(undefined);

  await runtimeLoginCancel("codex", null);

  expect(invokeMock).toHaveBeenCalledWith("runtime_login_cancel", {
    runtime: "codex",
    loginId: null,
  });
});
```

In `runtime-store.test.ts`, add tests with deferred promises:

```ts
it("exposes starting and lets cancel invalidate a pre-id login", async () => {
  let resolveStart: ((value: RuntimeLoginStartResult) => void) | undefined;
  commandMocks.runtimeLoginStart.mockReturnValue(
    new Promise((resolve) => { resolveStart = resolve; }),
  );

  const start = useRuntimeStore.getState().startLogin("codex", "browser");
  expect(useRuntimeStore.getState().login.codex).toEqual({
    mode: "browser",
    status: "starting",
    loginId: null,
  });

  await useRuntimeStore.getState().cancelLogin("codex");
  expect(commandMocks.runtimeLoginCancel).toHaveBeenCalledWith("codex", null);
  expect(useRuntimeStore.getState().login.codex).toBeNull();

  resolveStart?.({
    type: "chatgpt",
    authUrl: "https://auth.example/late",
    loginId: "late-login",
  });
  await start;
  expect(useRuntimeStore.getState().login.codex).toBeNull();
});

it("shows verifying while an account poll is in flight", async () => {
  await startBrowserLogin("verify-login");
  let resolveStatus: ((value: RuntimeAccount) => void) | undefined;
  commandMocks.runtimeStatus.mockReturnValue(
    new Promise((resolve) => { resolveStatus = resolve; }),
  );

  vi.advanceTimersByTime(1_000);
  await Promise.resolve();
  expect(useRuntimeStore.getState().login.codex).toMatchObject({
    status: "verifying",
    loginId: "verify-login",
  });

  resolveStatus?.(account("codex", { authenticated: false }));
  await Promise.resolve();
  expect(useRuntimeStore.getState().login.codex).toMatchObject({
    status: "waiting",
    loginId: "verify-login",
  });
});
```

Change the existing timeout test expectation from 180 attempts/seconds to 600 attempts/seconds.

- [ ] **Step 2: Run frontend tests and verify RED**

Run:

```powershell
pnpm --dir apps/desktop exec vitest run src/__tests__/runtime/commands.test.ts src/__tests__/stores/runtime-store.test.ts
```

Expected: FAIL because cancellation still requires a string ID and `starting`/`verifying` states are absent.

- [ ] **Step 3: Extend frontend login types and command payload**

In `runtime/types.ts`, add these variants before the existing waiting variants:

```ts
export type InteractiveRuntimeLoginMode = "browser" | "device-code";

export type RuntimeLoginState =
  | {
      mode: InteractiveRuntimeLoginMode;
      status: "starting";
      loginId: null;
    }
  | {
      mode: "browser";
      status: "waiting" | "verifying";
      loginId: string;
      authUrl: string;
    }
  | {
      mode: "device-code";
      status: "waiting" | "verifying";
      loginId: string;
      verificationUrl: string;
      userCode: string;
    }
  | { mode: "api-key"; status: "complete"; loginId: null }
  | {
      mode: "browser" | "device-code" | "api-key";
      status: "error";
      loginId: string | null;
      message: string;
    };
```

Change `runtimeLoginCancel` in `runtime/commands.ts` to accept `loginId: string | null` and always send `{ runtime, loginId }`.

- [ ] **Step 4: Implement state transitions and ten-minute polling**

In `runtime-store.ts`:

```ts
const LOGIN_POLL_INTERVAL_MS = 1_000;
const LOGIN_POLL_LIMIT = 600;
```

At the beginning of `startLogin`, set interactive modes to `{ mode, status: "starting", loginId: null }` instead of clearing login to `null`. Preserve the existing epoch checks. In `runPoll`, copy the current interactive login into a `verifying` variant before awaiting `runtimeStatus`; if the current result is unauthenticated, restore the same login details with `status: "waiting"`. Transient poll errors also restore `waiting` and continue.

Change `cancelLogin` so a `starting` login invokes `runtimeLoginCancel(runtime, null)`, invalidates the epoch, and clears the UI. Waiting/verifying/error states with an ID invoke cancellation with that exact ID.

Ensure `completeAuthenticatedLogin` triggers `refreshModels("codex")` only when it consumed a non-null current login state. Repeated account events after the state was cleared must not create duplicate refreshes.

- [ ] **Step 5: Run the focused store/command tests and checkpoint**

Run:

```powershell
pnpm --dir apps/desktop exec vitest run src/__tests__/runtime/commands.test.ts src/__tests__/stores/runtime-store.test.ts
git diff --check -- apps/desktop/src/runtime/types.ts apps/desktop/src/runtime/commands.ts apps/desktop/src/stores/runtime-store.ts apps/desktop/src/__tests__/runtime/commands.test.ts apps/desktop/src/__tests__/stores/runtime-store.test.ts
```

Expected: PASS with no unhandled timer warnings. Leave changes unstaged.

### Task 3: Add the bundled model registry and catalog response type

**Files:**
- Create: `apps/desktop/src-tauri/src/runtime/codex/model_registry.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/codex/mod.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/mod.rs`
- Test: inline tests in `model_registry.rs`

- [ ] **Step 1: Write the bundled-registry RED test**

Create `model_registry.rs` with only the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_registry_maps_catalog_keys_to_explicit_wire_ids() {
        let models = bundled_model_registry();
        let pairs = models
            .iter()
            .map(|entry| (entry.catalog_id, entry.wire_id))
            .collect::<Vec<_>>();

        assert_eq!(
            pairs,
            vec![
                ("gpt-5-6-sol", "gpt-5.6-sol"),
                ("gpt-5-6-terra", "gpt-5.6-terra"),
                ("gpt-5-6-luna", "gpt-5.6-luna"),
                ("gpt-5-5", "gpt-5.5"),
                ("gpt-5-4", "gpt-5.4"),
                ("gpt-5-4-mini", "gpt-5.4-mini"),
                ("gpt-5-3-codex-spark", "gpt-5.3-codex-spark"),
            ]
        );
        assert_eq!(models.iter().filter(|entry| entry.is_default).count(), 1);
        assert!(models.iter().all(|entry| !entry.wire_id.contains("-5-6-")));
    }
}
```

Add `pub mod model_registry;` to `runtime/codex/mod.rs` so the test compiles far enough to fail on the missing types/functions.

- [ ] **Step 2: Run the registry test and verify RED**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline bundled_registry_maps_catalog_keys_to_explicit_wire_ids -- --nocapture
```

Expected: FAIL because `RegistryModel` and `bundled_model_registry` are absent.

- [ ] **Step 3: Implement an independent, versioned registry**

Add this focused representation:

```rust
pub(crate) const BUNDLED_MODEL_REGISTRY_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RegistryModel {
    pub(crate) catalog_id: &'static str,
    pub(crate) wire_id: &'static str,
    pub(crate) display_name: &'static str,
    pub(crate) is_default: bool,
}

pub(crate) fn bundled_model_registry() -> Vec<RegistryModel> {
    vec![
        RegistryModel { catalog_id: "gpt-5-6-sol", wire_id: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", is_default: true },
        RegistryModel { catalog_id: "gpt-5-6-terra", wire_id: "gpt-5.6-terra", display_name: "GPT-5.6 Terra", is_default: false },
        RegistryModel { catalog_id: "gpt-5-6-luna", wire_id: "gpt-5.6-luna", display_name: "GPT-5.6 Luna", is_default: false },
        RegistryModel { catalog_id: "gpt-5-5", wire_id: "gpt-5.5", display_name: "GPT-5.5", is_default: false },
        RegistryModel { catalog_id: "gpt-5-4", wire_id: "gpt-5.4", display_name: "GPT-5.4", is_default: false },
        RegistryModel { catalog_id: "gpt-5-4-mini", wire_id: "gpt-5.4-mini", display_name: "GPT-5.4 Mini", is_default: false },
        RegistryModel { catalog_id: "gpt-5-3-codex-spark", wire_id: "gpt-5.3-codex-spark", display_name: "GPT-5.3 Codex Spark", is_default: false },
    ]
}

pub(crate) fn bundled_runtime_models() -> Vec<RuntimeModel> {
    bundled_model_registry()
        .into_iter()
        .map(|entry| RuntimeModel {
            runtime: RuntimeKind::Codex,
            id: entry.wire_id.to_string(),
            display_name: entry.display_name.to_string(),
            description: Some("Bundled OpenAI Codex model catalog entry".into()),
            reasoning_efforts: Vec::new(),
            default_reasoning_effort: None,
            input_modalities: vec!["text".into(), "image".into()],
            is_default: entry.is_default,
        })
        .collect()
}
```

Do not derive wire IDs by string replacement. Empty reasoning metadata intentionally lets Codex choose its server default when neither live nor cache metadata is available.

- [ ] **Step 4: Add a catalog wrapper at the Tauri boundary**

In `runtime/mod.rs`, add:

```rust
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeModelCatalogSource {
    Live,
    Cache,
    Registry,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModelCatalog {
    pub runtime: RuntimeKind,
    pub source: RuntimeModelCatalogSource,
    pub models: Vec<RuntimeModel>,
}
```

Change `runtime_list_models` to return `Result<RuntimeModelCatalog, String>`. Wrap Claude models as `source: Live`; Task 4 will return the resolved Codex catalog.

- [ ] **Step 5: Run registry/type tests and checkpoint**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline bundled_registry_ -- --nocapture
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline account_and_models_ -- --test-threads=1
git diff --check -- apps/desktop/src-tauri/src/runtime/codex/model_registry.rs apps/desktop/src-tauri/src/runtime/codex/mod.rs apps/desktop/src-tauri/src/runtime/mod.rs
```

Expected: registry test PASS; any compile failures now identify all call sites that Task 4 must update. Do not stage overlapping dirty files.

### Task 4: Implement live-first catalog resolution

**Files:**
- Create: `apps/desktop/src-tauri/src/runtime/codex/model_catalog.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/codex/models_cache.rs`
- Modify: `apps/desktop/src-tauri/src/runtime/codex/mod.rs`
- Test: inline tests in `model_catalog.rs`
- Test: inline tests in `models_cache.rs`

- [ ] **Step 1: Write RED precedence and enrichment tests**

Create this test helper before the cases:

```rust
fn model(
    id: &str,
    display_name: &str,
    reasoning_efforts: Vec<&str>,
    is_default: bool,
) -> RuntimeModel {
    RuntimeModel {
        runtime: RuntimeKind::Codex,
        id: id.to_string(),
        display_name: display_name.to_string(),
        description: None,
        reasoning_efforts: reasoning_efforts
            .into_iter()
            .map(str::to_string)
            .collect(),
        default_reasoning_effort: None,
        input_modalities: Vec::new(),
        is_default,
    }
}
```

Then add:

```rust
#[test]
fn non_empty_live_catalog_is_authoritative_and_only_enriched_by_id() {
    let live = vec![model("gpt-5.6-sol", "", vec![], true)];
    let cache = vec![
        model("gpt-5.6-sol", "GPT-5.6 Sol", vec!["low", "high"], false),
        model("cache-only", "Cache Only", vec!["medium"], false),
    ];
    let registry = vec![model("registry-only", "Registry Only", vec![], false)];

    let catalog = resolve_codex_catalog(Ok(live), cache, registry).unwrap();

    assert_eq!(catalog.source, RuntimeModelCatalogSource::Live);
    assert_eq!(catalog.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["gpt-5.6-sol"]);
    assert_eq!(catalog.models[0].display_name, "GPT-5.6 Sol");
    assert_eq!(catalog.models[0].reasoning_efforts, vec!["low", "high"]);
    assert!(catalog.models[0].is_default, "live default must not be overwritten");
}

#[test]
fn empty_or_failed_live_catalog_falls_back_cache_then_registry() {
    let cached = vec![model("cached", "Cached", vec![], true)];
    let bundled = vec![model("bundled", "Bundled", vec![], true)];

    let cache_catalog = resolve_codex_catalog(Ok(vec![]), cached.clone(), bundled.clone()).unwrap();
    assert_eq!(cache_catalog.source, RuntimeModelCatalogSource::Cache);
    assert_eq!(cache_catalog.models[0].id, "cached");

    let registry_catalog = resolve_codex_catalog(Err("offline".into()), vec![], bundled).unwrap();
    assert_eq!(registry_catalog.source, RuntimeModelCatalogSource::Registry);
    assert_eq!(registry_catalog.models[0].id, "bundled");

    let error = resolve_codex_catalog(Err("offline".into()), vec![], vec![]).unwrap_err();
    assert_eq!(error, "offline");
}

#[test]
fn live_catalog_deduplicates_wire_ids_without_reordering() {
    let live = vec![
        model("gpt-a", "A", vec![], true),
        model("gpt-a", "A duplicate", vec![], false),
        model("gpt-b", "B", vec![], false),
    ];
    let catalog = resolve_codex_catalog(Ok(live), vec![], vec![]).unwrap();
    assert_eq!(catalog.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["gpt-a", "gpt-b"]);
}
```

- [ ] **Step 2: Run resolver tests and verify RED**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline resolve_codex_catalog -- --nocapture
```

Expected: FAIL because `resolve_codex_catalog` is not implemented.

- [ ] **Step 3: Implement the pure resolver**

In `model_catalog.rs`, implement the complete pure resolver:

```rust
use crate::runtime::{
    RuntimeKind, RuntimeModel, RuntimeModelCatalog, RuntimeModelCatalogSource,
};
use std::collections::HashSet;

fn catalog(
    source: RuntimeModelCatalogSource,
    models: Vec<RuntimeModel>,
) -> RuntimeModelCatalog {
    RuntimeModelCatalog {
        runtime: RuntimeKind::Codex,
        source,
        models,
    }
}

fn fill_missing_metadata(target: &mut RuntimeModel, source: &RuntimeModel) {
    if target.display_name.trim().is_empty() {
        target.display_name = source.display_name.clone();
    }
    if target
        .description
        .as_deref()
        .is_none_or(|description| description.trim().is_empty())
    {
        target.description = source.description.clone();
    }
    if target.reasoning_efforts.is_empty() {
        target.reasoning_efforts = source.reasoning_efforts.clone();
    }
    if target.default_reasoning_effort.is_none() {
        target.default_reasoning_effort = source.default_reasoning_effort.clone();
    }
    if target.input_modalities.is_empty() {
        target.input_modalities = source.input_modalities.clone();
    }
}

fn enrich_and_deduplicate(
    live: Vec<RuntimeModel>,
    cached: &[RuntimeModel],
    bundled: &[RuntimeModel],
) -> Vec<RuntimeModel> {
    let mut seen = HashSet::new();
    let mut resolved = Vec::new();

    for mut model in live {
        if !seen.insert(model.id.clone()) {
            continue;
        }
        if let Some(metadata) = cached
            .iter()
            .find(|candidate| candidate.id == model.id)
            .or_else(|| bundled.iter().find(|candidate| candidate.id == model.id))
        {
            fill_missing_metadata(&mut model, metadata);
        }
        resolved.push(model);
    }

    resolved
}

pub(crate) fn resolve_codex_catalog(
    live: Result<Vec<RuntimeModel>, String>,
    cached: Vec<RuntimeModel>,
    bundled: Vec<RuntimeModel>,
) -> Result<RuntimeModelCatalog, String> {
    match live {
        Ok(live) if !live.is_empty() => Ok(RuntimeModelCatalog {
            runtime: RuntimeKind::Codex,
            source: RuntimeModelCatalogSource::Live,
            models: enrich_and_deduplicate(live, &cached, &bundled),
        }),
        Ok(_) if !cached.is_empty() => Ok(catalog(RuntimeModelCatalogSource::Cache, cached)),
        Ok(_) => Ok(catalog(RuntimeModelCatalogSource::Registry, bundled)),
        Err(_) if !cached.is_empty() => Ok(catalog(RuntimeModelCatalogSource::Cache, cached)),
        Err(_) if !bundled.is_empty() => Ok(catalog(RuntimeModelCatalogSource::Registry, bundled)),
        Err(error) => Err(error),
    }
}
```

The implementation preserves the first live occurrence and live ordering. It never overwrites `is_default`, appends a cache/registry-only model, or changes the wire ID. If the repository's Rust toolchain does not yet support `Option::is_none_or`, replace only that condition with an equivalent `match`; do not change resolver semantics.

- [ ] **Step 4: Replace cache-first merging in `codex::list_models`**

Expose `read_models_cache_catalog` from `models_cache.rs`, remove production use of `merge_codex_models`, and change `codex::list_models` to:

```rust
pub(super) async fn list_models(
    app: &tauri::AppHandle,
    state: &CodexAppServerState,
) -> Result<RuntimeModelCatalog, String> {
    let live = list_models_with_request(MODEL_PAGE_LIMIT, |method, params| {
        state.request(app, method, params)
    })
    .await;
    model_catalog::resolve_codex_catalog(
        live,
        models_cache::read_models_cache_catalog(),
        model_registry::bundled_runtime_models(),
    )
}
```

Keep the existing item-by-item page parser, `includeHidden=true`, repeated-cursor protection, internal-model filtering, and page limit.

- [ ] **Step 5: Run all focused model tests and checkpoint**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline account_and_models_ -- --test-threads=1
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline model_catalog -- --test-threads=1
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline models_cache -- --test-threads=1
git diff --check -- apps/desktop/src-tauri/src/runtime/codex/model_catalog.rs apps/desktop/src-tauri/src/runtime/codex/model_registry.rs apps/desktop/src-tauri/src/runtime/codex/models_cache.rs apps/desktop/src-tauri/src/runtime/codex/mod.rs apps/desktop/src-tauri/src/runtime/mod.rs
```

Expected: PASS; a non-empty live fixture never gains cache-only IDs.

### Task 5: Carry catalog source and login states through the UI

**Files:**
- Modify: `apps/desktop/src/runtime/types.ts`
- Modify: `apps/desktop/src/runtime/commands.ts`
- Modify: `apps/desktop/src/stores/runtime-store.ts`
- Modify: `apps/desktop/src/components/runtime/runtime-card.tsx`
- Modify: `apps/desktop/src/components/runtime/runtime-selector.tsx`
- Test: `apps/desktop/src/__tests__/runtime/commands.test.ts`
- Test: `apps/desktop/src/__tests__/stores/runtime-store.test.ts`
- Test: `apps/desktop/src/__tests__/components/runtime-card.test.tsx`
- Test: `apps/desktop/src/__tests__/components/runtime-selector.test.tsx`

- [ ] **Step 1: Add RED catalog parsing and fallback-notice tests**

Add to `commands.test.ts`:

```ts
it("returns a tagged Codex model catalog", async () => {
  invokeMock.mockResolvedValue({
    runtime: "codex",
    source: "registry",
    models: [model("codex", "gpt-5.6-sol")],
  });

  await expect(runtimeListModels("codex")).resolves.toMatchObject({
    runtime: "codex",
    source: "registry",
    models: [{ id: "gpt-5.6-sol" }],
  });
});
```

Add to `runtime-store.test.ts`:

```ts
it("stores the Codex catalog source without adding fallback-only models", async () => {
  commandMocks.runtimeListModels.mockResolvedValue({
    runtime: "codex",
    source: "cache",
    models: [model("codex", "gpt-cached")],
  });

  await useRuntimeStore.getState().refreshModels("codex");

  expect(useRuntimeStore.getState().modelCatalogSources.codex).toBe("cache");
  expect(useRuntimeStore.getState().models.codex.map(({ id }) => id)).toEqual(["gpt-cached"]);
});
```

In `runtime-selector.test.tsx`, render a ready Codex runtime with `source: "registry"` and assert:

```ts
expect(screen.getByRole("status")).toHaveTextContent(
  "Using the bundled Codex model catalog",
);
expect(screen.getByText(/availability is confirmed when you send/i)).toBeInTheDocument();
```

In `runtime-card.test.tsx`, cover `starting` and `verifying` labels while keeping cancel/reopen controls usable.

- [ ] **Step 2: Run the four frontend test files and verify RED**

Run:

```powershell
pnpm --dir apps/desktop exec vitest run src/__tests__/runtime/commands.test.ts src/__tests__/stores/runtime-store.test.ts src/__tests__/components/runtime-card.test.tsx src/__tests__/components/runtime-selector.test.tsx
```

Expected: FAIL because model catalog/source types and the new status messages do not exist.

- [ ] **Step 3: Add catalog types and store state**

In `runtime/types.ts`, add:

```ts
export type RuntimeModelCatalogSource = "live" | "cache" | "registry";

export interface RuntimeModelCatalog {
  runtime: RuntimeKind;
  source: RuntimeModelCatalogSource;
  models: RuntimeModel[];
}
```

Change `runtimeListModels` to `Promise<RuntimeModelCatalog>`. Validate that the result runtime matches the requested runtime, source is one of the three allowed values, and `models` is an array; reject invalid responses as `Invalid runtime model catalog response`.

Add to `RuntimeState` and `initialData`:

```ts
modelCatalogSources: Partial<Record<RuntimeKind, RuntimeModelCatalogSource>>;
```

In `refreshModels`, store `catalog.models` and `catalog.source` under the same `modelEpoch` guard. A stale catalog or error must not overwrite a newer source.

- [ ] **Step 4: Render actionable login and fallback states**

In `runtime-card.tsx`:

```tsx
const loginStarting = login?.status === "starting";
const interactiveLogin =
  login?.status === "waiting" || login?.status === "verifying" ? login : null;
const loginVerifying = interactiveLogin?.status === "verifying";
const browserAuthUrl =
  interactiveLogin?.mode === "browser" ? interactiveLogin.authUrl : null;

{loginStarting && <p role="status">Starting Codex browser login…</p>}
{loginVerifying && <p role="status">Checking Codex authorization…</p>}
{browserAuthUrl && (
  <button type="button" onClick={() => onOpenUrl(browserAuthUrl)}>
    Open authorization page
  </button>
)}
{(loginStarting || interactiveLogin) && (
  <button type="button" onClick={onCancelLogin}>
    Cancel
  </button>
)}
```

Fit this into the existing card layout without duplicating its current waiting controls. Terminal errors retain Retry; browser-open failure is not converted into a login error.

In `runtime-selector.tsx`, derive the Codex source from `useRuntimeStore`. Render exactly one non-blocking `role="status"` notice:

```tsx
{codexReady && codexCatalogSource === "cache" && (
  <p role="status">Using the local Codex model cache. Refresh to check live availability.</p>
)}
{codexReady && codexCatalogSource === "registry" && (
  <p role="status">
    Using the bundled Codex model catalog; availability is confirmed when you send.
  </p>
)}
```

Do not show a fallback notice for `live`.

- [ ] **Step 5: Run focused UI/store tests and checkpoint**

Run:

```powershell
pnpm --dir apps/desktop exec vitest run src/__tests__/runtime/commands.test.ts src/__tests__/stores/runtime-store.test.ts src/__tests__/components/runtime-card.test.tsx src/__tests__/components/runtime-selector.test.tsx
git diff --check -- apps/desktop/src/runtime/types.ts apps/desktop/src/runtime/commands.ts apps/desktop/src/stores/runtime-store.ts apps/desktop/src/components/runtime/runtime-card.tsx apps/desktop/src/components/runtime/runtime-selector.tsx
```

Expected: PASS; fallback notice is absent for live catalogs.

### Task 6: Enforce model and reasoning selection at send time

**Files:**
- Modify: `apps/desktop/src/components/claude-chat/chat-composer.tsx`
- Modify: `apps/desktop/src/stores/claude-chat-store.ts`
- Test: `apps/desktop/src/__tests__/components/runtime-selector.test.tsx`
- Test: `apps/desktop/src/__tests__/stores/dual-runtime-chat.test.ts`

- [ ] **Step 1: Add RED selection and rejected-model tests**

Add pure selection cases to `runtime-selector.test.tsx` for the exported helper used by the composer:

```ts
expect(getSelectedCodexModel(models, null)?.id).toBe("live-default");
expect(getSelectedCodexModel(models, "persisted-valid")?.id).toBe("persisted-valid");
expect(getSelectedCodexModel(models, "persisted-missing")).toBeNull();
```

Add to `dual-runtime-chat.test.ts`:

```ts
it("blocks an unavailable persisted Codex model instead of silently switching", async () => {
  seedCodexTab({ runtimeModel: "removed-model", sessionId: "thread-1" });
  useRuntimeStore.setState({
    models: { claude: [], codex: [model("codex", "gpt-live")] },
  });

  await useClaudeChatStore.getState().sendPrompt("hello");

  expect(runtimeMocks.startRuntimeTurn).not.toHaveBeenCalled();
  expect(activeTab().error).toMatch(/removed-model.*no longer available/i);
});

it("refreshes models after a server-side unavailable-model error", async () => {
  runtimeMocks.startRuntimeTurn.mockRejectedValue(
    new Error("model gpt-old is unavailable"),
  );

  await useClaudeChatStore.getState().sendPrompt("hello");

  expect(commandMocks.runtimeListModels).toHaveBeenCalledWith("codex");
  expect(activeTab().error).toMatch(/refresh.*select another model/i);
  expect(runtimeMocks.startRuntimeTurn).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run selector/chat tests and verify RED**

Run:

```powershell
pnpm --dir apps/desktop exec vitest run src/__tests__/components/runtime-selector.test.tsx src/__tests__/stores/dual-runtime-chat.test.ts
```

Expected: FAIL because missing persisted models currently fall through or reach the runtime, and rejected models do not refresh the catalog.

- [ ] **Step 3: Implement explicit selection rules**

Keep `getSelectedCodexModel` deterministic:

```ts
export function getSelectedCodexModel(
  models: RuntimeModel[],
  selectedId: string | null,
): RuntimeModel | null {
  if (selectedId) return models.find(({ id }) => id === selectedId) ?? null;
  return models.find(({ isDefault }) => isDefault) ?? models[0] ?? null;
}
```

For an existing Codex session with a non-null `runtimeModel` that is absent from the current catalog, disable Send and show the explicit unavailable-model message. For a new chat with no model, select the catalog default or first model.

Before constructing `RuntimeTurnRequest`, normalize reasoning effort:

```ts
function validReasoningEffort(model: RuntimeModel, effort: string | null): string | null {
  if (effort && model.reasoningEfforts.includes(effort)) return effort;
  return model.defaultReasoningEffort;
}
```

An empty bundled-registry effort list produces `null`, allowing Codex to use its server default.

- [ ] **Step 4: Refresh after a model rejection without silently retrying**

In the Codex error branch of `sendPrompt`, detect only clear unavailable-model messages:

```ts
const unavailableModel = /\bmodel\b.*\b(unavailable|not found|unsupported|does not exist)\b/i;
```

If matched, call `useRuntimeStore.getState().refreshModels("codex")` best-effort and surface: `The selected Codex model is no longer available. Refresh and select another model.` Do not invoke `startRuntimeTurn` again and do not change the selected model automatically.

- [ ] **Step 5: Run focused chat/selector tests and checkpoint**

Run:

```powershell
pnpm --dir apps/desktop exec vitest run src/__tests__/components/runtime-selector.test.tsx src/__tests__/stores/dual-runtime-chat.test.ts
git diff --check -- apps/desktop/src/components/claude-chat/chat-composer.tsx apps/desktop/src/stores/claude-chat-store.ts apps/desktop/src/__tests__/components/runtime-selector.test.tsx apps/desktop/src/__tests__/stores/dual-runtime-chat.test.ts
```

Expected: PASS and no silent second `startRuntimeTurn` call.

### Task 7: Integration regression and real Windows acceptance

**Files:**
- Test: all files changed in Tasks 1–6
- Preserve: `.tmp/`, Skills stash/WIP, unrelated runtime/API/Claude changes

- [ ] **Step 1: Run the complete focused Rust gate**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline account_and_models_ -- --test-threads=1
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline model_catalog -- --test-threads=1
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline models_cache -- --test-threads=1
```

Expected: all focused Rust tests PASS with no hangs.

- [ ] **Step 2: Run the frontend runtime/chat gate**

Run:

```powershell
pnpm --dir apps/desktop exec vitest run src/__tests__/runtime/commands.test.ts src/__tests__/stores/runtime-store.test.ts src/__tests__/components/runtime-card.test.tsx src/__tests__/components/runtime-selector.test.tsx src/__tests__/components/runtime-settings.test.tsx src/__tests__/components/app-runtime-lifecycle.test.tsx src/__tests__/stores/dual-runtime-chat.test.ts src/__tests__/hooks/use-claude-events.test.tsx
```

Expected: all selected frontend tests PASS; no leaked timers, unhandled rejections, or React warnings.

- [ ] **Step 3: Run compile and formatting checks**

Run:

```powershell
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline
pnpm --dir apps/desktop exec tsc --noEmit
git diff --check
```

Expected: all commands exit 0. Formatting commands may mechanically update files only when subsequently run without `--check`; inspect every resulting path before accepting such changes.

- [ ] **Step 4: Start the desktop app for user-controlled browser authorization**

Run:

```powershell
pnpm --dir apps/desktop exec tauri dev
```

Acceptance sequence:

1. Begin browser subscription login from Codex settings.
2. Confirm `Starting` appears, then `Waiting`; Cancel and Open remain usable.
3. Complete browser authorization when prompted by the user-controlled browser.
4. Confirm the UI reports authenticated account details and a non-empty live model catalog.
5. Confirm the catalog source is `live`, not cache/registry, for this acceptance run.
6. Select one live OpenAI model and complete a real streamed prompt/answer.
7. Resume the same conversation and complete a second prompt/answer.
8. Logout, confirm live models are no longer ready, and perform one successful re-login.
9. Smoke-test one Claude conversation to detect dual-runtime regressions.

Do not claim completion if only fake-server tests, compilation, fallback models, or UI text work.

- [ ] **Step 5: Review the final scoped diff and request commit/build authority**

Run:

```powershell
git status --short
git diff --stat
git diff -- apps/desktop/src-tauri/src/runtime/codex/model_registry.rs apps/desktop/src-tauri/src/runtime/codex/model_catalog.rs apps/desktop/src-tauri/src/runtime/codex/models_cache.rs apps/desktop/src-tauri/src/runtime/codex/mod.rs apps/desktop/src-tauri/src/runtime/mod.rs apps/desktop/src/runtime/types.ts apps/desktop/src/runtime/commands.ts apps/desktop/src/stores/runtime-store.ts apps/desktop/src/components/runtime/runtime-card.tsx apps/desktop/src/components/runtime/runtime-selector.tsx apps/desktop/src/components/claude-chat/chat-composer.tsx apps/desktop/src/stores/claude-chat-store.ts
```

Expected: only intended additions appear in these paths; all unrelated dirty files remain preserved. Ask the user before staging overlapping WIP, creating a consolidated commit, or rebuilding the NSIS installer.

## Plan self-review record

- Spec coverage: authentication ownership, starting/waiting/verifying/cancel paths, 60-second start bound, 10-minute authorization bound, live/cache/registry precedence, explicit wire IDs, fallback notices, unavailable-model behavior, security, regression, and real acceptance are each mapped to a task.
- Type consistency: backend and frontend both use `RuntimeModelCatalog`, with sources serialized as `live`, `cache`, and `registry`; `RuntimeModel.id` remains the wire ID.
- Scope: no direct OAuth/token storage, no API runtime, no unrelated refactor, and no installer build before real acceptance.
- Dirty-tree safety: path-level checkpoints replace automatic commits for already modified files.
