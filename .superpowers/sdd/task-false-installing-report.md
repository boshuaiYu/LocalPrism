# Task Report: False Codex Installing UI

## Status

**SUCCESS**

## Root cause

1. `environment-onboarding.tsx` called non-silent `refreshRuntimes()` on startup.
   If `runtime_status` hung, `loadingCounts.codex` never cleared.
2. `RuntimeCard` treated any `loading && !installed` as Installing (button
   "Installing…"), so a hung status refresh looked like a stuck install with
   an empty log (no "Starting Codex check…").

## Fix

### A. `environment-onboarding.tsx`

Startup refresh is silent:

```ts
refreshRuntimes(undefined, { silent: true })
```

### B. `runtime-store.ts`

- Added `installInFlight: Partial<Record<RuntimeKind, boolean>>`.
- `install()` sets `installInFlight[runtime]=true` at start and clears it in
  `finally` (always).
- Non-silent `refresh()` races `runtimeStatus` against
  `STATUS_WATCHDOG_MS = 10_000`; on timeout sets account error and clears
  loading in `finally`.
- `refresh` accepts `{ silent?: boolean }` (silent skips loading flags and
  watchdog).

### C. `runtime-card.tsx` + `runtime-settings.tsx`

```ts
const installing = Boolean(installInFlight) && !account.installed && !!onInstall;
```

- Badge: Installing… only when `installInFlight`; otherwise loading → Working…
- Button: `Checking Codex…` only when installing
- `controlsLocked = loading || installInFlight` (timeout clears loading so
  retry works)

### D. Tests

- Card: loading without `installInFlight` does **not** show Installing /
  Checking Codex
- Store: `install()` sets/clears `installInFlight`; hung refresh times out
- Onboarding: startup uses `{ silent: true }`

## Ancestor check

HEAD parent includes discovery fix:

`8959d6fd7979305abb747e5a4028b08aacf76db2` —
`fix(codex): skip WindowsApps scan during fast Codex probe`

## Commit

- Message: `fix(runtime): stop mistaking hung status for Codex install`
- Files: onboarding, runtime-store, runtime-card, runtime-settings, related
  tests, this report

## Tests

```text
vitest run runtime-card / runtime-store / environment-onboarding
→ 93 passed
```

## Rebuild

```text
corepack pnpm build:desktop
→ NSIS copied to .tmp/ClaudePrism_1.3.0_x64-setup-codex-login-fix.exe
```

## Result

| Item | Value |
|------|-------|
| Commit | _(filled after commit)_ |
| Tests | 93 passed (card/store/onboarding) |
| Exe | `.tmp/ClaudePrism_1.3.0_x64-setup-codex-login-fix.exe` |
| Discovery ancestor | `8959d6fd` present |
| Verdict | **SUCCESS** |
