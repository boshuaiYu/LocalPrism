# Regression and Windows Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove existing Claude behavior and every new dual-runtime requirement, then produce verified Windows NSIS EXE and WiX MSI installers with clean-install, upgrade, launch, and uninstall evidence.

**Architecture:** Convert the current lint-only pull-request workflow into required frontend/Rust/release-verifier gates, add a dependency-free artifact/version verifier, and make release jobs fail hard when expected bundles are missing. Run installer smoke checks in disposable Windows profiles, preserve non-secret user-state sentinels across upgrade, and maintain a requirement-to-evidence ledger that distinguishes updater signing from Authenticode.

**Tech Stack:** Node 22 built-ins and `node:test`, PowerShell 7, GitHub Actions, pnpm, Vitest, Cargo, Tauri 2, NSIS, WiX/MSI, SHA-256, Windows uninstall registry.

---

**Program position:** Plan 4 of 4. Execute after the other three plans. Even after every acceptance row is green, completion is withheld until Task 9's independent read-only review loop returns an evidence-backed approval.

## Requirement coverage map

1. Independent Claude/Codex install and auth: foundation Tasks 3, 5, and 7; release Task 7.
2. Send, stream, cancel, and resume without cross-routing: foundation Tasks 6, 8, and 9; release Tasks 1 and 7.
3. Dynamic Codex models and reasoning configuration: foundation Tasks 5, 6, and 9; release Task 7.
4. Skills for Claude, Codex, or both: skills/agents Tasks 1-4; release Task 7.
5. Native Claude and Codex custom agents with assigned skills: skills/agents Tasks 5-7; release Task 7.
6. Real child receives its assigned skill: subagents/approvals Task 8; release Task 7.
7. Visible active/completed/failed/cancelled child hierarchy: subagents/approvals Tasks 2, 5-8; release Task 7.
8. Existing Claude and OpenAI-compatible regression: foundation regression gates and release Tasks 1, 3, and 8.
9. Frontend, Rust, lint, build, and Tauri Windows gates: release Tasks 2-4 and 8.
10. NSIS EXE and MSI existence plus install smoke: release Tasks 2, 4, 5, and 8.
11. Upgrade preserves projects, sessions, provider config, history, and unmanaged skills: release Tasks 6-8.
12. Independent six-dimension review/repair loop: release Task 9.

## File map

**Create**

- `scripts/verify-release.mjs` - version/tag/artifact/signature verifier and JSON evidence writer.
- `scripts/verify-release.test.mjs` - dependency-free verifier unit tests.
- `scripts/windows-installer-smoke.ps1` - guarded NSIS/MSI install/launch/upgrade/uninstall checks.
- `scripts/select-prior-release.mjs` - select the newest lower semantic version with both Windows installer assets.
- `scripts/select-prior-release.test.mjs` - deterministic prior-release selection tests.
- `docs/release/dual-runtime-acceptance.md` - requirement/evidence ledger and exact manual QA fields.
- `docs/release/evidence/strict-review-loop.md` - independent review iterations, repair commits, and final verdict.
- `docs/release/evidence/.gitkeep` - evidence directory without fabricated results.
- `apps/desktop/src/__tests__/stores/dual-runtime-regression.test.ts` - Claude/Codex cross-routing and failure isolation.

**Modify**

- `package.json:14-21` - release verification scripts.
- `.github/workflows/lint.yml:9-24` - required JS and Rust quality jobs.
- `.github/workflows/build-desktop.yml:25-121,513-620` - frozen install, tests, explicit bundles, hard artifact verification, smoke dependencies, verified publishing.
- `apps/desktop/src/__tests__/stores/claude-chat-send-prompt.test.ts:184-295` - preserve Claude/OpenAI-compatible routing assertions.
- `apps/desktop/src/__tests__/stores/claude-setup-store.test.ts:125-438` - preserve Claude/provider account behavior.
- `apps/desktop/src/__tests__/stores/multi-tab-merge.test.ts:219-439` - add cross-runtime concurrent tab isolation.
- `apps/desktop/src-tauri/src/claude.rs` existing unit tests - preserve auth/provider/session behavior.
- `apps/desktop/src-tauri/src/lib.rs:590-649` - test command registration compatibility.

### Task 1: Lock the requirement-to-test regression matrix

**Files:**

- Create: `apps/desktop/src/__tests__/stores/dual-runtime-regression.test.ts`
- Modify: existing Claude store tests listed above.
- Create: `docs/release/dual-runtime-acceptance.md`

- [ ] **Step 1: Write cross-runtime regression tests before any release changes**

Mock the typed runtime command boundary and cover this matrix:

```ts
const cases = [
  { tab: "claude", runtime: "claude", command: "runtime_start_turn" },
  { tab: "codex", runtime: "codex", command: "runtime_start_turn" },
  { tab: "deepseek", runtime: "claude", providerCredentialId: "deepseek" },
] as const;
```

Assert new send, resume, streaming event, cancel, failure, and retry for each applicable path. Start Claude and Codex concurrently, cancel one, and prove the other remains streaming. Assert OpenAI-compatible providers always use `runtime:"claude"` and never Codex account/model/session state.

- [ ] **Step 2: Add command-registration compatibility assertions**

Keep all existing Claude command names at `lib.rs:602-625` registered while neutral commands coexist. A Rust test or a shared static command-name list must cover `check_claude_status`, install/login/provider credential commands, execute/continue/resume/cancel, fast mode, session list/title/history/delete, and every new `runtime_*`, `skill_*`, and `agent_*` command.

- [ ] **Step 3: Run regression tests and fix only genuine failures**

Run:

```powershell
corepack pnpm --filter @claude-prism/desktop test -- claude-chat-send-prompt claude-setup-store multi-tab-merge dual-runtime-regression
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml claude --lib
```

Expected: PASS with no weakened pre-existing assertions.

- [ ] **Step 4: Create the acceptance ledger structure**

Use one row for each approved acceptance criterion with columns: Requirement, Automated proof, Real-runtime proof, Windows artifact proof, Status, Evidence path. Initialize Status to `Not run`; do not write PASS until the referenced command/artifact was produced in the current release candidate.

- [ ] **Step 5: Commit the regression matrix**

```powershell
git add apps/desktop/src/__tests__/stores docs/release/dual-runtime-acceptance.md apps/desktop/src-tauri/src
git commit -m "test: lock dual-runtime regression coverage"
```

### Task 2: Add a dependency-free release/version/artifact verifier

**Files:**

- Create: `scripts/verify-release.mjs`
- Create: `scripts/verify-release.test.mjs`
- Modify: `package.json:14-21`

- [ ] **Step 1: Write failing Node tests with temporary fixtures**

Cover matching versions, root/desktop/Cargo/lock/Tauri mismatch, tag mismatch, missing or duplicate NSIS, missing or duplicate MSI, zero-byte artifact, conditional missing updater signature, and stable SHA-256 evidence.

```js
test("requires one NSIS and one MSI", async () => {
  const result = await verifyWindowsArtifacts({ bundleDir, requireUpdaterSignature: false });
  assert.equal(result.nsis.name, "ClaudePrism_1.4.0_x64-setup.exe");
  assert.equal(result.msi.name, "ClaudePrism_1.4.0_x64_en-US.msi");
});
```

- [ ] **Step 2: Run the verifier tests and verify failure**

Run:

```powershell
node --test scripts/verify-release.test.mjs
```

Expected: FAIL because the verifier is missing.

- [ ] **Step 3: Implement manifest version extraction**

Export:

```js
export async function verifyManifestVersions({ root, tag }) {
  const versions = {
    root: JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
    desktop: JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8")).version,
    tauri: JSON.parse(await readFile(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8")).version,
    cargo: extractCargoPackageVersion(await readFile(join(root, "apps/desktop/src-tauri/Cargo.toml"), "utf8")),
    lock: extractLockedPackageVersion(await readFile(join(root, "apps/desktop/src-tauri/Cargo.lock"), "utf8"), "claude-prism-desktop"),
  };
  const unique = new Set(Object.values(versions));
  if (unique.size !== 1) throw new Error(`Manifest version mismatch: ${JSON.stringify(versions)}`);
  const version = versions.root;
  if (tag && tag !== `v${version}`) throw new Error(`Release tag ${tag} does not equal v${version}`);
  return { version, versions };
}
```

Use anchored package-section parsing for Cargo files; do not select an unrelated dependency version.

- [ ] **Step 4: Implement exact artifact verification**

Export `findExactlyOneArtifact`, `verifyWindowsArtifacts`, and `writeEvidence`. Search recursively, require one nonempty `*-setup.exe` and one nonempty `.msi`, require version in each filename, and require the NSIS `.sig` only when updater signing is configured. Evidence contains filename, relative path, byte size, and SHA-256, never secret environment values.

- [ ] **Step 5: Add CLI and package scripts**

Add:

```json
"verify:release": "node scripts/verify-release.mjs",
"test:release-verifier": "node --test scripts/verify-release.test.mjs scripts/select-prior-release.test.mjs"
```

CLI flags are `--root`, `--tag`, `--bundle-dir`, `--output`, and `--require-updater-signature`.

- [ ] **Step 6: Run tests and verify current manifests**

```powershell
node --test scripts/verify-release.test.mjs
node scripts/verify-release.mjs --root . --output docs/release/evidence/local-version-check.json
```

Expected: tests pass and current five manifest versions agree. The local evidence file records no installer PASS because no bundle directory was supplied.

- [ ] **Step 7: Commit the verifier**

```powershell
git add scripts/verify-release.mjs scripts/verify-release.test.mjs package.json docs/release/evidence/local-version-check.json
git commit -m "build: verify release versions and Windows artifacts"
```

### Task 3: Make frontend and Rust regression checks required in CI

**Files:**

- Modify: `.github/workflows/lint.yml:9-24`

- [ ] **Step 1: Add the JavaScript quality job**

Use Node 22 and pnpm setup, then run exactly:

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm exec biome ci
- run: pnpm --filter @claude-prism/desktop test
- run: pnpm --filter @claude-prism/desktop build
- run: pnpm test:release-verifier
```

- [ ] **Step 2: Add a Rust quality job with native libraries**

On Ubuntu 22.04 install the same HarfBuzz/Graphite2/ICU/font packages as the existing Linux build job, install stable Rust, and set `TECTONIC_DEP_BACKEND=pkg-config`, `TECTONIC_PKGCONFIG_FORCE_SEMI_STATIC=true`, `CXXFLAGS=-std=c++17`, `CFLAGS=`. Run:

```yaml
- run: cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all -- --check
- run: cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --locked -- -D warnings
- run: cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --locked
```

- [ ] **Step 3: Validate workflow syntax and run equivalent local commands**

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm exec biome ci
corepack pnpm --filter @claude-prism/desktop test
corepack pnpm --filter @claude-prism/desktop build
corepack pnpm test:release-verifier
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all -- --check
```

Expected: all locally available gates pass; Rust compilation uses a correctly configured native environment.

- [ ] **Step 4: Commit CI quality gates**

```powershell
git add .github/workflows/lint.yml
git commit -m "ci: require frontend and Rust regression gates"
```

### Task 4: Harden Windows build and publication jobs

**Files:**

- Modify: `.github/workflows/build-desktop.yml:25-121,513-620`

- [ ] **Step 1: Freeze every dependency install**

Change all four platform jobs from `pnpm install` to `pnpm install --frozen-lockfile`. For manual `release_tag`, checkout `refs/tags/<release_tag>` after validating the input matches `^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$`; artifact-only dispatch without a tag keeps the selected workflow ref.

- [ ] **Step 2: Add pre-build version and test gates**

Before each platform build run version verification. In Windows, after vcpkg/Rust setup and before packaging run frontend tests/build, release-verifier tests, and locked Rust tests. Set `RELEASE_TAG` from the pushed/manual tag and pass it only when nonempty.

- [ ] **Step 3: Build both Windows bundle formats explicitly**

Use PowerShell line continuation in a PowerShell step:

```powershell
pnpm --filter @claude-prism/desktop tauri build `
  --target x86_64-pc-windows-msvc `
  --bundles nsis,msi
```

- [ ] **Step 4: Verify bundles and publish paths from evidence**

After build run:

```powershell
$args = @(
  "scripts/verify-release.mjs",
  "--root", ".",
  "--bundle-dir", "apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle",
  "--output", "release-evidence/windows-artifacts.json"
)
if ($env:RELEASE_TAG) { $args += @("--tag", $env:RELEASE_TAG) }
if ($env:TAURI_SIGNING_PRIVATE_KEY) { $args += "--require-updater-signature" }
node @args
```

Read verified artifact paths from the JSON instead of `find | head -1` in collection/publish logic.

- [ ] **Step 5: Fail hard and upload evidence**

Set Windows `if-no-files-found: error`. Upload EXE, MSI, signatures, `windows-artifacts.json`, hashes, and later smoke logs. Make `publish` require the Windows smoke jobs, so a draft release is never created from uninstalled artifacts.

- [ ] **Step 6: Run local workflow-equivalent verification**

On configured Windows:

```powershell
corepack pnpm --filter @claude-prism/desktop tauri build --target x86_64-pc-windows-msvc --bundles nsis,msi
node scripts/verify-release.mjs --root . --bundle-dir apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle --output docs/release/evidence/local-windows-artifacts.json
```

Expected: exactly one nonempty setup EXE and MSI are recorded.

- [ ] **Step 7: Commit workflow hardening**

```powershell
git add .github/workflows/build-desktop.yml docs/release/evidence/local-windows-artifacts.json
git commit -m "ci: require verified Windows EXE and MSI bundles"
```

### Task 5: Implement guarded NSIS and MSI clean-install smoke tests

**Files:**

- Create: `scripts/windows-installer-smoke.ps1`

- [ ] **Step 1: Add parameter and safety guards**

Use:

```powershell
param(
  [ValidateSet("Nsis", "Msi")] [string]$Format,
  [Parameter(Mandatory)] [string]$Installer,
  [Parameter(Mandatory)] [string]$ExpectedVersion,
  [string]$PreviousInstaller,
  [Parameter(Mandatory)] [string]$EvidenceDirectory,
  [switch]$RequireAuthenticode,
  [switch]$DisposableProfile
)

if ($env:CI -ne "true" -and -not $DisposableProfile) {
  throw "Installer smoke tests are allowed only in CI or an explicitly disposable Windows profile."
}
```

Resolve every path and require installer files under the workspace/artifact directory before executing.

- [ ] **Step 2: Implement checked process execution**

`Invoke-CheckedProcess` waits, records command name/exit code/duration/log path, accepts `0` and MSI `3010`, and throws otherwise. Never include environment values or command arguments containing secrets in evidence.

- [ ] **Step 3: Implement install/uninstall primitives**

Use exactly:

```powershell
# NSIS install/uninstall
Start-Process -FilePath $Installer -ArgumentList "/S" -Wait -PassThru
Start-Process -FilePath $Uninstaller -ArgumentList "/S" -Wait -PassThru

# MSI install/uninstall
Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", $Installer, "/qn", "/norestart", "/L*v", $InstallLog) -Wait -PassThru
Start-Process -FilePath "msiexec.exe" -ArgumentList @("/x", $Installer, "/qn", "/norestart", "/L*v", $UninstallLog) -Wait -PassThru
```

Discover install location, version, and uninstaller from both 32/64-bit HKLM uninstall registry views by matching `DisplayName = ClaudePrism`; do not assume `Program Files` paths.

- [ ] **Step 4: Implement launch verification**

Start the discovered executable with `Start-Process -WindowStyle Hidden`, wait up to 30 seconds for a live process and main executable path match, record version, then stop only that process. A port check is not sufficient evidence for this desktop app.

- [ ] **Step 5: Report Authenticode separately**

Call `Get-AuthenticodeSignature`. Always record status, signer subject when present, and timestamp status. Fail on non-Valid only with `-RequireAuthenticode`. Do not treat a Tauri updater `.sig` as Authenticode.

- [ ] **Step 6: Write smoke evidence and verify script parsing**

Evidence JSON includes format, expected/installed version, installer hash/size, registry entry, launch result, uninstall result, Authenticode result, timestamps, and logs. Parse the script without executing installers:

```powershell
[void][scriptblock]::Create((Get-Content -LiteralPath scripts/windows-installer-smoke.ps1 -Raw))
```

Expected: no parse exception.

- [ ] **Step 7: Commit the smoke harness**

```powershell
git add scripts/windows-installer-smoke.ps1
git commit -m "test: add guarded Windows installer smoke checks"
```

### Task 6: Add prior-release selection and upgrade preservation tests

**Files:**

- Create: `scripts/select-prior-release.mjs`
- Create: `scripts/select-prior-release.test.mjs`
- Modify: `scripts/windows-installer-smoke.ps1`
- Modify: `.github/workflows/build-desktop.yml`

- [ ] **Step 1: Write prior-release selection tests**

Given release metadata, choose the highest stable semantic version lower than the candidate that has both `ClaudePrism-Windows-setup.exe` and `ClaudePrism-Windows.msi`. Reject the candidate version, prereleases unless candidate is a prerelease, drafts, and releases missing either installer.

- [ ] **Step 2: Run tests and verify failure**

```powershell
node --test scripts/select-prior-release.test.mjs
```

Expected: FAIL because the selector is absent.

- [ ] **Step 3: Implement deterministic selection**

The CLI reads a GitHub API JSON file or stdin, writes `{tag,nsisUrl,msiUrl}` to the requested output, and exits nonzero when no eligible prior release exists. The CI job fetches release metadata with its scoped GitHub token and downloads assets; URLs/tokens are not written to public evidence.

- [ ] **Step 4: Seed non-secret upgrade sentinels**

In the disposable profile, before candidate upgrade, create and hash:

```text
%APPDATA%/ClaudePrism/anthropic-auth.json (dummy schema, no real key)
%USERPROFILE%/.claude/projects/smoke-session.jsonl
%USERPROFILE%/.claude/skills/unmanaged-smoke/SKILL.md
%USERPROFILE%/.agents/skills/unmanaged-smoke/SKILL.md
%USERPROFILE%/Documents/ClaudePrism/UpgradeSmoke/main.tex
%USERPROFILE%/Documents/ClaudePrism/UpgradeSmoke/.claudeprism/history.git/sentinel
```

Store SHA-256 and relative paths before upgrade. Install the prior version, seed sentinels, install the candidate over it, verify installed version/launch, compare all hashes, then uninstall. A missing or changed sentinel fails the job.

- [ ] **Step 5: Add separate fresh Windows jobs**

Create `smoke-windows-nsis`, `smoke-windows-msi`, and `smoke-windows-upgrade`. Each downloads verified build artifacts into a fresh `windows-latest` job and runs the harness. NSIS and MSI do not share an installed state. Upload logs/evidence with `if-no-files-found:error`.

- [ ] **Step 6: Run selector tests and commit**

```powershell
node --test scripts/select-prior-release.test.mjs
git add scripts/select-prior-release.mjs scripts/select-prior-release.test.mjs scripts/windows-installer-smoke.ps1 .github/workflows/build-desktop.yml
git commit -m "test: verify Windows upgrade preserves user state"
```

### Task 7: Execute the Windows 11 and real-runtime acceptance matrix

**Files:**

- Modify during execution: `docs/release/dual-runtime-acceptance.md`
- Create during execution: `docs/release/evidence/windows-11-runtime-matrix.json`
- Reuse: `docs/release/evidence/dual-runtime-child-agent.json`

- [ ] **Step 1: Prepare a disposable Windows 11 VM**

Record OS build and architecture. The VM must not have ClaudePrism user data. Use separate snapshots for: no CLI, Claude CLI only, independently installed Codex CLI only, Codex desktop packaged CLI only, and both CLIs.

- [ ] **Step 2: Verify discovery and onboarding states**

For each snapshot, install the candidate EXE, launch it, and record runtime installed/authenticated/version states. In the Codex desktop snapshot, prove the discovered executable matches `OpenAI.Codex_*_x64__*\app\resources\codex.exe`; upgrade the desktop app and prove rediscovery does not reuse the old versioned path.

- [ ] **Step 3: Verify real authentication and model flow**

With QA accounts/network, test Claude login, Codex browser login, Codex device-code login, Codex API-key login, logout/refresh, and simultaneous Claude+Codex authentication. Record account mode labels only; redact email/key/token/auth URLs. Prove Codex picker values and reasoning efforts came from `model/list` and reached start/turn configuration.

- [ ] **Step 4: Verify concurrent conversation behavior**

Run Claude and Codex turns concurrently, independently cancel each, resume both sessions after restart, archive a Codex thread, and confirm existing OpenAI-compatible provider routing still uses Claude. Capture hashed session/thread IDs and state transitions.

- [ ] **Step 5: Verify Skills, agents, approvals, and children**

Run the plan-2 native file checks and plan-3 child nonce checks for both runtimes. Exercise command/file approval allow, deny, cancel, and session persistence; confirm no request remains pending. Verify Active/Done/failure/cancel hierarchy and restart recovery.

- [ ] **Step 6: Run NSIS/MSI/upgrade smoke on Windows 11**

Use the guarded harness with `-DisposableProfile`. Record both installers, launch/uninstall, user-state preservation, updater signature presence, and Authenticode separately.

- [ ] **Step 7: Write scrubbed matrix evidence**

`windows-11-runtime-matrix.json` records versions, OS, scenario, booleans/results, hashed identifiers, evidence artifact names, and timestamps. It excludes credentials, prompts containing user data, raw home paths, and hidden reasoning.

### Task 8: Run the final completion audit and release gate

**Files:**

- Modify: `docs/release/dual-runtime-acceptance.md`
- Collect: `docs/release/evidence/*.json`

- [ ] **Step 1: Run every automated gate from a clean checkout**

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm exec biome ci
corepack pnpm --filter @claude-prism/desktop test
corepack pnpm --filter @claude-prism/desktop build
corepack pnpm test:release-verifier
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --locked
```

Expected: every command exits `0`.

- [ ] **Step 2: Build and verify signed/update artifacts**

```powershell
corepack pnpm --filter @claude-prism/desktop tauri build --target x86_64-pc-windows-msvc --bundles nsis,msi
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
node scripts/verify-release.mjs --root . --tag "v$version" --bundle-dir apps/desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle --output docs/release/evidence/final-windows-artifacts.json
```

Expected: one NSIS EXE and one MSI with hashes; updater signature requirement follows signing configuration.

- [ ] **Step 3: Audit all eleven acceptance rows**

For each row, open the referenced current test output, real-runtime evidence, installer evidence, and source/config. Mark PASS only if evidence directly covers the whole requirement. Missing Windows 11, real-account, real-child, prior-upgrade, MSI, or NSIS evidence keeps the row `Not complete` and keeps the active goal open.

- [ ] **Step 4: Verify repository integrity**

```powershell
git diff --check
git status --short
git log --oneline --decorate -20
```

Expected: no accidental generated schema, credentials, temporary installers, node_modules, target output, or unredacted QA logs are tracked.

- [ ] **Step 5: Commit final evidence and release changes**

```powershell
git add .github package.json pnpm-lock.yaml scripts apps/desktop/src apps/desktop/src-tauri docs/release
git commit -m "release: verify dual Claude and Codex desktop support"
```

- [ ] **Step 6: Advance to independent review only after the audit is fully green**

All eleven ledger rows must be PASS with current evidence before Task 9 starts. A green unit suite alone, protocol fixtures alone, or installer file existence alone is insufficient. Do not mark the active goal complete at this step.

### Task 9: Run an independent strict-review and repair loop

**Files:**

- Create: `docs/release/evidence/strict-review-loop.md`
- Read: approved design, all four implementation plans, acceptance ledger, source diff, test output, real-runtime evidence, and installer evidence.
- Modify during repairs: only files named by an accepted repair checklist; the review task itself remains read-only.

- [ ] **Step 1: Prepare a scrubbed review packet**

Collect the approved design path, four plan paths, base and candidate commit hashes, `git diff --stat`, all eleven acceptance rows, exact automated command results, real Claude/Codex matrix, child-agent evidence, Windows artifact hashes, NSIS/MSI/upgrade smoke results, updater signature status, and Authenticode status. Exclude credentials, auth URLs, personal account labels, raw prompts, signed URLs, and hidden reasoning.

- [ ] **Step 2: Create a genuinely independent Codex task only after implementation is complete**

Use the Codex desktop thread creation capability to create a separate task titled `Strict review: dual Claude and Codex runtime`. Point it at the completed feature worktree/branch and provide the scrubbed packet. Do not reuse an implementation subagent and do not grant the reviewer authority to edit, stage, commit, reset, or delete files. The reviewer may inspect source, run read-only diagnostics, run tests/builds that write only normal generated outputs, and inspect artifacts.

- [ ] **Step 3: Give the reviewer the exact six-dimension contract**

Send this required output contract:

```text
Review the completed dual Claude/Codex feature without modifying source files.

Evaluate independently:
1. Requirement completeness
2. Logical correctness
3. Boundary and failure cases
4. Code quality and maintainability
5. Test coverage and whether tests prove the claims
6. Actual runtime and installer results

For every finding include severity, requirement, file/line or artifact, reproducible evidence, why current evidence is insufficient, and a concrete acceptance test for the repair.

Return exactly one verdict:
VERDICT: CHANGES_REQUIRED
with an ordered repair checklist, or
VERDICT: APPROVED
with a requirement-by-requirement evidence table and any explicitly non-blocking observations.

Do not edit, stage, or commit code. Do not approve based only on the main task's summary.
```

- [ ] **Step 4: Validate the review before accepting its verdict**

Read the independent task's full response. Reject a verdict that omits any of the six dimensions, lacks direct evidence, ignores an acceptance row, or treats missing real-runtime/Windows evidence as passing. Ask the same task to complete the missing review rather than silently accepting it.

- [ ] **Step 5: Turn every blocking finding into a main-task repair checklist**

Copy each accepted finding into `strict-review-loop.md` with review iteration, severity, cited evidence, repair owner (main task), targeted failing test to add first, and required verification. The independent task never performs the repair.

- [ ] **Step 6: Repair in the main task with TDD and current evidence**

For each item: reproduce or add the failing test, run it and observe failure, implement the smallest complete fix, run focused tests, run all affected regression gates, and commit. After all items in the iteration, rerun the complete Task 8 gate and refresh any invalidated real-runtime or installer evidence.

- [ ] **Step 7: Return the repair packet to the same independent task**

Send the repair commit hashes, finding-to-change mapping, new/updated tests, exact outputs, and refreshed artifacts to the existing strict-review task. Request a full six-dimension re-review of the new candidate, not merely confirmation that checklist items were touched.

- [ ] **Step 8: Repeat until the reviewer returns a valid approval**

Continue Steps 4-7 for every `CHANGES_REQUIRED` verdict. There is no iteration limit and no severity may be waived merely to finish. Stop only when the independent task returns `VERDICT: APPROVED`, covers all six dimensions, maps every original requirement to current evidence, and has no unresolved blocking finding.

- [ ] **Step 9: Record final independent evidence**

In `strict-review-loop.md`, record the independent task ID/link, every iteration date and reviewed commit, findings and repair commits, verification commands/artifacts, final verdict, and the reviewer's evidence table. Keep the reviewer's wording concise and scrub secrets. Link this file from `dual-runtime-acceptance.md` as the final process gate.

- [ ] **Step 10: Commit the review record and only then claim completion**

```powershell
git add docs/release/dual-runtime-acceptance.md docs/release/evidence/strict-review-loop.md docs/release/evidence
git commit -m "docs: record independent dual-runtime verification"
```

After a clean status check and fresh confirmation that the final commit is the commit reviewed or only adds the review record, mark the active goal complete. If any repair or evidence is still pending, keep the goal active.

## Final evidence required

- Full Claude/OpenAI-compatible regression output.
- Full dual-runtime frontend/Rust/lint/build output.
- Real Claude and Codex auth/model/send/cancel/resume evidence.
- Real skill import and native custom-agent assignment evidence for both runtimes.
- Real child-agent assigned-skill visibility and parent/status UI evidence.
- Exactly one verified NSIS EXE and one MSI, plus hashes and updater signature status.
- Fresh NSIS and MSI install/launch/uninstall logs.
- Prior-release upgrade evidence preserving projects, sessions, provider config, history, and unmanaged skills.
- Separate Authenticode status that never conflates updater signing with Windows code signing.
- Independent read-only review history covering all six requested dimensions, every repair iteration, and a final evidence-backed `APPROVED` verdict.
