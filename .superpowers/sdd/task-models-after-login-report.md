# Task: Codex models after ChatGPT login

## Status

**Done** — ChatGPT login completion now refreshes the Codex model catalog, and a failed one-shot selector fetch no longer permanently sticks on "No Codex models available".

## Root cause

1. `completeAuthenticatedLogin` cleared login UI state but never called `refreshModels("codex")`.
2. `RuntimeSelector` set `refreshRequestedRef.current = true` before `onRefreshCodexModels()` and left it true on rejection, so a transient first failure never retried.

## Changes

| File | Change |
|------|--------|
| `apps/desktop/src/stores/runtime-store.ts` | After clearing login for `runtime === "codex"`, kick off `refreshModels("codex")` (errors still land in `account.error`). |
| `apps/desktop/src/__tests__/stores/runtime-store.test.ts` | Default `runtimeListModels` → `[]`; assert authenticated Codex account event calls `runtimeListModels("codex")` and populates models. |
| `apps/desktop/src/components/runtime/runtime-selector.tsx` | On refresh rejection, reset `refreshRequestedRef` so a later effect can retry. |
| `apps/desktop/src/__tests__/components/runtime-selector.test.tsx` | Assert failed one-shot fetch retries after loading settles. |

Optional Retry button: skipped (effect retry + auth-time refresh covers the path).

## Test commands / results

```text
cd apps/desktop
npm test -- src/__tests__/stores/runtime-store.test.ts -t "refreshes Codex models when authentication completes"
npm test -- src/__tests__/components/runtime-selector.test.tsx -t "retries Codex model refresh|refreshes an authenticated empty"
npm test -- src/__tests__/stores/runtime-store.test.ts src/__tests__/components/runtime-selector.test.tsx
```

Focused (this fix):

```text
refreshes Codex models when authentication completes — passed
retries Codex model refresh after a failed one-shot fetch — passed
refreshes an authenticated empty Codex list once without a render loop — passed
```

Full two-file suite after commit:

```text
Tests  2 failed | 91 passed (93)
```

The 2 failures are **pre-existing on HEAD** (unrelated to this fix): tests expect `refresh(..., { silent: true })` / post-install `runtimeStatus` probing that is not in the committed `runtime-store.ts` (local WIP elsewhere). Confirmed by running those two cases against pure HEAD before this change.

RED→GREEN for this task:

- `refreshes Codex models when authentication completes` — failed (0 `runtimeListModels` calls) before fix; passed after.
- `retries Codex model refresh after a failed one-shot fetch` — failed (stuck at 1 call) before fix; passed after.

## Commit

`2ef8f4a` — `fix(runtime): load Codex models after ChatGPT login succeeds`
