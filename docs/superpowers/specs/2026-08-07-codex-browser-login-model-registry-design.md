# Codex Browser Login and Model Registry Design

**Date:** 2026-08-07

## Goal

Make Codex browser-subscription login reliable in LocalPrism and ensure an authenticated user can select and use the OpenAI models available to that account. Keep device-code and API-key login as secondary paths. Treat a real browser login, a non-empty model picker, a completed streamed answer, and a resumed follow-up turn as the acceptance boundary.

## Context

LocalPrism already integrates Codex through the official `codex app-server` JSON-RPC boundary. The current implementation supports `account/login/start`, `account/login/cancel`, `account/read`, `account/logout`, paginated `model/list`, `thread/start`, and `turn/start`. It also contains substantial uncommitted runtime and chat lifecycle work that must be preserved.

Cherry Studio separates authentication lifecycle from model catalog discovery. This design adopts that separation without copying Cherry Studio's direct OAuth/token-storage layer. LocalPrism will continue to let `codex app-server` own ChatGPT credentials and token refresh, while LocalPrism owns UI state, request bounds, catalog normalization, fallback policy, and user-facing recovery.

## Scope

### In scope

- ChatGPT/Codex browser subscription login as the primary sign-in path.
- Device-code and OpenAI API-key login retained as secondary paths.
- Explicit, race-safe login states and cancellation.
- Live account model discovery through `model/list`.
- On-disk Codex cache and a bundled, versioned registry as fallback catalogs.
- Stable mapping from catalog identifiers to the actual model identifier sent to Codex.
- Actionable errors, model-source visibility, and regression tests.
- Real Windows acceptance for login, model selection, chat, and resume.

### Out of scope

- A second LocalPrism-owned OAuth implementation.
- Storing or refreshing ChatGPT access and refresh tokens in LocalPrism.
- Claiming that every bundled registry model is available to every subscription.
- Silently replacing a user-selected model after the server rejects it.
- Refactoring unrelated Claude, API-provider, Skills, Zotero, or subagent work.

## Architecture

### 1. Authentication ownership

`codex app-server` remains the sole owner of ChatGPT credentials. LocalPrism requests browser login, receives an authorization URL and login ID, opens the URL, listens for account notifications, and verifies the result with `account/read`. No OAuth client ID, PKCE verifier, access token, refresh token, or ChatGPT account token is persisted by LocalPrism.

The login UI and store use these observable states:

1. `idle`: no active login.
2. `starting`: `account/login/start` is in flight and no login ID is available yet.
3. `waiting`: an authorization URL and login ID are available.
4. `verifying`: a completion notification arrived and LocalPrism is confirming the account.
5. `success`: `account/read` reports `authenticated=true`.
6. `error`: a terminal start, authorization, verification, or timeout error occurred.
7. `cancelled`: the active attempt was locally superseded or cancelled and late results cannot change current state.

Only one interactive Codex login attempt may be current. Both the Rust app-server state and the frontend store retain generation/epoch checks so an older response, poll, or notification cannot overwrite a newer login or logout.

### 2. Browser login data flow

1. The user selects browser subscription login.
2. LocalPrism transitions to `starting` and invokes `account/login/start` with the ChatGPT browser mode.
3. A valid response supplies `authUrl` and `loginId`; LocalPrism transitions to `waiting` and attempts to open the system browser.
4. Browser-open failure leaves the attempt active and exposes a persistent `Open authorization page` action.
5. `account/login/completed` or `account/updated` triggers a serialized `account/read` verification.
6. Polling `account/read` remains a fallback for lost notifications; transient poll failures do not terminate the attempt.
7. Authentication succeeds only when `account/read` returns `authenticated=true`.
8. Success immediately refreshes the Codex model catalog.

The start request is bounded to 60 seconds. The complete interactive authorization window is bounded to 10 minutes. Cancelling after a login ID exists invokes `account/login/cancel`. Cancelling while start is still in flight invalidates the local generation; if a late response supplies a login ID, LocalPrism cancels or abandons that stale server attempt without exposing it as current.

### 3. Model catalog resolver

Model discovery is a source-ordered resolver:

1. **Live app-server catalog.** Request all `model/list` pages with `includeHidden=true`. Parse entries independently so one malformed entry cannot invalidate a page. Filter internal-only models such as `codex-auto-review`. If at least one usable live model remains, this list is authoritative.
2. **Official on-disk cache.** If the live request fails or yields no usable model, read `CODEX_HOME/models_cache.json` or `~/.codex/models_cache.json` using the existing soft-fail parser.
3. **Bundled registry.** If both live and cache catalogs are empty, return a versioned registry shipped with LocalPrism. Registry records contain a catalog key and a separate wire model identifier, display name, reasoning efforts, input modalities, description, and default rank.

When the live catalog is authoritative, cache or registry metadata may enrich a matching wire model ID, but fallback sources must not introduce additional models into that live list. This prevents the picker from advertising models the authenticated account did not return.

`RuntimeModel.id` remains the actual wire model identifier used by `thread/start` and persisted conversations. Catalog keys are internal metadata and are never transformed by blindly replacing hyphens or periods. For example, a registry key may differ from `gpt-5.6-sol`, but the request always sends the explicit wire identifier `gpt-5.6-sol`.

The resolver returns catalog source metadata (`live`, `cache`, or `registry`) with the list. The UI shows a non-blocking fallback notice for cache or registry results. A successful later live refresh replaces the fallback list.

### 4. Model selection behavior

- A persisted selection is retained when its wire ID exists in the authoritative list.
- A new Codex chat with no valid selection uses the live default model, then the first live model, then the fallback default.
- An existing conversation whose model disappears is marked unavailable and requires an explicit replacement before sending; it is not silently migrated.
- If `thread/start` or `turn/start` rejects a model as unavailable, LocalPrism refreshes the live catalog and presents an actionable selection error. It does not retry with another model automatically.
- Reasoning effort is validated against the selected model's advertised efforts. An invalid persisted effort falls back to that model's default effort, not an arbitrary global value.

## Error Handling and Security

- Transient `account/read`, browser-open, notification, and `model/list` failures do not clear otherwise valid credentials.
- Terminal authorization failures preserve a safe, actionable message and a retry action.
- Errors and logs never include API keys, access tokens, refresh tokens, authorization query strings, or raw credential responses.
- API-key login keeps its current secret-minimal request boundary and generic failure text.
- Repeated model cursors, excessive pagination, malformed pages, and empty identifiers are handled deterministically.
- The model picker distinguishes `no live models yet` from `not authenticated` and from `catalog refresh failed`.
- Logout invalidates login, account, and model generations; late work cannot re-authenticate the UI or restore stale models.

## Compatibility

- Keep `RuntimeKind` limited to `claude` and `codex`; do not add an API runtime.
- Keep existing Tauri command names and current conversation wire shapes.
- Keep `RuntimeModel.id` as the request model ID to avoid persisted-tab migration.
- Add optional catalog-source or catalog-key fields in a backward-compatible way.
- Preserve current uncommitted Codex process, chat lifecycle, onboarding, API-provider, and runtime UI changes unless a directly overlapping edit is required.

## Test Strategy

All production behavior changes follow red-green-refactor.

### Rust tests

- Browser start success, invalid shape, bounded start, and safe error mapping.
- Completion before start response, null login ID, mismatched login ID, newer-attempt supersession, transport restart, and cancellation races.
- Serialized verification and transient `account/read` failure.
- Paginated live model parsing, malformed-entry isolation, repeated cursor rejection, filtering, de-duplication, and stable order.
- Live non-empty precedence over cache and bundled registry.
- Live empty/error fallback to cache, then registry.
- Catalog-key to wire-ID mapping and reasoning-effort normalization.
- Model rejection returns an actionable error and does not silently retry another model.

### Frontend tests

- `starting`, `waiting`, `verifying`, `success`, `error`, and cancelled transitions.
- Browser-open failure keeps reopen and cancel controls usable.
- Login notification and polling races cannot revive stale attempts.
- Successful authentication triggers exactly one current model refresh.
- Live models replace fallback models; cache/registry source notices render correctly.
- Invalid persisted model and reasoning effort follow the explicit selection rules.
- Logout clears current login/model work while stale promises are ignored.

### Protocol integration tests

A fake newline-delimited JSON-RPC app-server covers browser login response, early and normal completion notifications, account verification, paginated models, and stale-response ordering. These tests verify component boundaries but do not replace real acceptance.

## Real Acceptance

On Windows, with the same discovered Codex binary used for status and app-server startup:

1. Start LocalPrism with no active Codex login.
2. Start browser subscription login and complete the user-controlled browser authorization.
3. Confirm `account/read` reports an authenticated account and the UI leaves the waiting state.
4. Confirm the model picker contains a non-empty live catalog and indicates the selected model.
5. Select an account-returned OpenAI model and complete one real streamed prompt/answer.
6. Resume the same Codex conversation and complete a second prompt/answer.
7. Logout, verify the account and live models are no longer ready, then log in again.
8. Run focused Rust and frontend suites plus relevant Claude/runtime regressions.
9. Rebuild an installer only after the preceding checks pass.

Mocks, compilation, UI text, and a generated installer alone are not acceptance.

## Implementation Boundary

The first implementation pass will touch only files required for login state, model catalog resolution, model metadata/wire mapping, selector behavior, and their tests. Existing unrelated dirty files and `.tmp` artifacts remain untouched. Any required overlap with an already modified file will be reviewed against its current diff before editing.
