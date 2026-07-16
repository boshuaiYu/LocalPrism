# Runtime Skills and Custom Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make skills runtime/scope-aware and add safe Claude/Codex custom-agent authoring with explicit assigned skills.

**Architecture:** Keep the existing curated scientific-skills workflow, but place runtime destinations and ownership behind a manifest so only ClaudePrism-managed copies can be removed in bulk. Store custom agents in each runtime's native format, preserve unknown fields, validate every path before writing, and expose both catalogs through typed Tauri commands and focused Zustand stores.

**Tech Stack:** Rust, Serde/Serde YAML, `toml_edit`, SHA-256, Tauri, React, TypeScript, Zustand, Vitest, Codex `skills/list` and `skills/config/write`.

---

**Program position:** Plan 2 of 4. Requires the shared runtime foundation from `2026-07-16-dual-runtime-foundation.md`. Complete this plan before subagent/approval UI work.

## File map

**Create**

- `apps/desktop/src-tauri/src/skills/domain.rs` - runtime/scope/ownership types.
- `apps/desktop/src-tauri/src/skills/paths.rs` - canonical runtime destinations and containment checks.
- `apps/desktop/src-tauri/src/skills/manifest.rs` - versioned managed-skill manifest and atomic persistence.
- `apps/desktop/src-tauri/src/skills/import.rs` - validation, staging, fingerprinting, and atomic copy.
- `apps/desktop/src-tauri/src/agents/mod.rs` - shared agent CRUD commands and validation.
- `apps/desktop/src-tauri/src/agents/claude.rs` - Claude Markdown/YAML parser and writer.
- `apps/desktop/src-tauri/src/agents/codex.rs` - Codex TOML parser and writer.
- `apps/desktop/src/stores/skill-store.ts` - runtime/scope-aware skill catalog and mutations.
- `apps/desktop/src/stores/agent-store.ts` - custom-agent catalog and mutations.
- `apps/desktop/src/components/skills/skill-library.tsx` - destination-aware catalog/import UI.
- `apps/desktop/src/components/skills/skill-target-picker.tsx` - Claude/Codex/user/project target selection.
- `apps/desktop/src/components/agents/agent-library.tsx` - runtime/scope filter and agent list.
- `apps/desktop/src/components/agents/agent-editor.tsx` - native-field editor and skill assignment.
- `apps/desktop/src/components/agents/agent-selector.tsx` - composer-compatible agent selection.
- `apps/desktop/src/components/settings/settings-dialog.tsx` - AI Runtimes, Skills, and Agents settings tabs.
- `apps/desktop/src/__tests__/stores/skill-store.test.ts` - target/ownership/visibility tests.
- `apps/desktop/src/__tests__/stores/agent-store.test.ts` - CRUD and assigned-skill tests.

**Modify**

- `apps/desktop/src-tauri/src/skills.rs:25-66,360-411,935-1103,1143-1508` - delegate old commands through the new safe primitives and retain compatibility commands.
- `apps/desktop/src-tauri/src/runtime/codex/mod.rs` - expose `skills/list` and `skills/config/write` helpers.
- `apps/desktop/src-tauri/src/lib.rs:1-10,637-649` - register `agents` and new skill/agent commands.
- `apps/desktop/src-tauri/Cargo.toml:21-42` and `Cargo.lock` - add `sha2` and `toml_edit`.
- `apps/desktop/src/runtime/types.ts` - add shared skill and custom-agent wire types.
- `apps/desktop/src/components/scientific-skills/scientific-skills-onboarding.tsx:38-170,204-302,410-648` - mount the new library while preserving curated categories.
- `apps/desktop/src/components/environment-onboarding.tsx` - report skill setup without making it a runtime-login gate.
- `apps/desktop/src/components/claude-chat/chat-composer.tsx` - mount `AgentSelector` after runtime/model/effort.
- `apps/desktop/src/stores/claude-chat-store.ts` - persist and send `agentId` already introduced by plan 1.
- `apps/desktop/src/components/project-wizard.tsx` - optional Codex support and non-destructive `AGENTS.md` creation.
- `apps/desktop/src/components/workspace/sidebar.tsx` - open the shared settings surface from the footer.

### Task 1: Define runtime/scope-aware skill identity and destinations

**Files:**

- Create: `apps/desktop/src-tauri/src/skills/domain.rs`
- Create: `apps/desktop/src-tauri/src/skills/paths.rs`
- Modify: `apps/desktop/src-tauri/src/skills.rs:25-66,360-411`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src/runtime/types.ts`

- [ ] **Step 1: Write destination and containment tests**

Cover all four targets and reject traversal, absolute folder names, symlink escapes, and a canonical target outside its selected root.

```rust
#[test]
fn resolves_codex_project_skills() {
    let root = Path::new("C:/paper");
    assert_eq!(
        resolve_skill_root(RuntimeKind::Codex, SkillScope::Project, Some(root)).unwrap(),
        root.join(".agents").join("skills"),
    );
}

#[test]
fn rejects_traversal_folder() {
    assert!(validate_skill_slug("../escape").is_err());
    assert!(validate_skill_slug("nested/escape").is_err());
}
```

- [ ] **Step 2: Run the tests and verify failure**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml skills::paths --lib
```

Expected: FAIL because the runtime-aware modules are absent.

- [ ] **Step 3: Implement the shared skill domain**

Use these exact wire types in `skills/domain.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillScope { User, Project }

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTarget {
    pub runtime: RuntimeKind,
    pub scope: SkillScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub folder: String,
    pub source_path: String,
    pub targets: Vec<SkillTarget>,
    pub managed: bool,
    pub compatible_runtimes: Vec<RuntimeKind>,
    pub enabled: bool,
    pub discovery_error: Option<String>,
}
```

Add matching `SkillScope`, `SkillTarget`, and `RuntimeSkill` definitions to `src/runtime/types.ts` in the same step.

- [ ] **Step 4: Implement the four canonical roots**

`paths.rs` resolves exactly:

```text
Claude user    <home>/.claude/skills
Claude project <project>/.claude/skills
Codex user     <home>/.agents/skills
Codex project  <project>/.agents/skills
```

The frontend receives resolved absolute paths from the backend. `resolve_skill_root` requires `project_path` for project scope and never falls back to the current directory.

- [ ] **Step 5: Add SHA-256 and TOML editing dependencies**

Add `sha2 = "0.10"` and `toml_edit = { version = "0.22", features = ["serde"] }` to normal dependencies, then update `Cargo.lock` with Cargo rather than hand editing it.

- [ ] **Step 6: Run focused tests and commit**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml skills::paths --lib
git add apps/desktop/src-tauri/src/skills apps/desktop/src-tauri/src/skills.rs apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock
git commit -m "refactor: add runtime-aware skill destinations"
```

Expected: tests pass and existing `skills_dir()` callers still resolve Claude locations through a compatibility wrapper.

### Task 2: Add a versioned ownership manifest without claiming legacy files

**Files:**

- Create: `apps/desktop/src-tauri/src/skills/manifest.rs`
- Modify: `apps/desktop/src-tauri/src/skills.rs`

- [ ] **Step 1: Write manifest round-trip and migration tests**

Use a temporary config directory. Cover: missing file, version 1 round-trip, duplicate target replacement, corrupt JSON backup, and an existing filesystem skill with no manifest entry remaining unmanaged.

```rust
#[test]
fn legacy_directory_is_visible_but_unmanaged() {
    let catalog = merge_manifest_with_disk(Vec::new(), vec![disk_skill("biopython")]);
    assert_eq!(catalog[0].managed, false);
}
```

- [ ] **Step 2: Run the tests and verify failure**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml skills::manifest --lib
```

Expected: FAIL because manifest types are missing.

- [ ] **Step 3: Implement the manifest schema**

Persist at `<config_dir>/ClaudePrism/skills-manifest.json`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillManifest {
    pub version: u32,
    pub entries: Vec<ManagedSkillEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SkillSource {
    Folder { path: String },
    Curated { package_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSkillEntry {
    pub id: String,
    pub declared_name: String,
    pub folder: String,
    pub source: SkillSource,
    pub content_sha256: String,
    pub target: SkillTarget,
    pub destination: String,
    pub installed_at: String,
    pub updated_at: String,
}
```

`id` is the stable string `"<runtime>:<scope>:<folder>"`. Write a sibling temporary file, `sync_all`, then rename. Back up corrupt JSON with a timestamp and start with an empty manifest; never delete the referenced skill directories during recovery.

- [ ] **Step 4: Implement safe ownership rules**

Bulk uninstall accepts manifest entry IDs and removes only destinations whose canonical path equals the matching entry destination and whose current fingerprint still matches the recorded managed copy. A changed managed copy is reported as `modified` and left intact until the user confirms single-item deletion. Existing unrecorded skills are never adopted automatically.

- [ ] **Step 5: Run tests and commit**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml skills::manifest --lib
git add apps/desktop/src-tauri/src/skills apps/desktop/src-tauri/src/skills.rs
git commit -m "feat: track managed skill ownership"
```

### Task 3: Validate and atomically install a skill to one or both runtimes

**Files:**

- Create: `apps/desktop/src-tauri/src/skills/import.rs`
- Modify: `apps/desktop/src-tauri/src/skills.rs:935-1103,1143-1508`
- Modify: `apps/desktop/src-tauri/src/runtime/codex/mod.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs:641-649`

- [ ] **Step 1: Write import validation tests**

Test: missing `SKILL.md`; valid `name` and `description`; extra frontmatter; legacy Claude-only metadata; invalid slug; nested resources copied; partial second-target failure rolls back both staged replacements; and an existing destination remains intact after a failed update.

```rust
#[test]
fn cross_runtime_import_requires_standard_metadata() {
    let parsed = validate_skill("---\nname: writer\ndescription: Writes prose\n---\n# Writer").unwrap();
    assert_eq!(parsed.compatible_runtimes, vec![RuntimeKind::Claude, RuntimeKind::Codex]);
}
```

- [ ] **Step 2: Run import tests and verify failure**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml skills::import --lib
```

Expected: FAIL because the atomic importer does not exist.

- [ ] **Step 3: Implement validation and fingerprinting**

Parse YAML frontmatter as a mapping, require non-empty `name` and `description` for Codex targets, retain all skill files, and hash sorted relative paths plus file bytes with SHA-256. A legacy Claude skill may target Claude only and returns a compatibility explanation instead of being rewritten.

- [ ] **Step 4: Implement two-phase installation**

For each requested target, copy into a hidden sibling staging directory, verify its canonical parent, compare the staged fingerprint, then swap it into the final destination. Only after all targets succeed should the manifest be updated. If a swap fails, restore every prior destination from its sibling backup.

Use this command contract:

```rust
#[tauri::command]
pub async fn skill_import(
    app: tauri::AppHandle,
    codex: tauri::State<'_, CodexAppServerState>,
    source_path: String,
    targets: Vec<SkillTarget>,
    project_path: Option<String>,
) -> Result<Vec<RuntimeSkill>, String>;

#[tauri::command]
pub async fn skill_list(
    app: tauri::AppHandle,
    codex: tauri::State<'_, CodexAppServerState>,
    project_path: Option<String>,
) -> Result<Vec<RuntimeSkill>, String>;

#[tauri::command]
pub async fn skill_delete_managed(
    app: tauri::AppHandle,
    entry_id: String,
    confirm_modified: bool,
) -> Result<(), String>;
```

- [ ] **Step 5: Verify Codex visibility through the runtime**

After any Codex target mutation, call `skills/list` with `{cwds:[projectPath],forceReload:true}` for project scope or `{cwds:[],forceReload:true}` for user scope. Match by canonical `path`, copy `enabled`, and surface every `errors[]` entry. Filesystem existence alone must not set `enabled=true`.

- [ ] **Step 6: Preserve existing commands as adapters**

Keep `install_scientific_skills_global`, `import_skill_from_folder`, `list_installed_skills`, and the other registered names until the frontend migration is complete. They target Claude user scope and call the new primitives; `uninstall_scientific_skills` removes only manifest-owned curated entries and no longer recursively removes all of `~/.claude/skills`.

- [ ] **Step 7: Run all Rust skill tests and commit**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml skills --lib
git add apps/desktop/src-tauri/src/skills apps/desktop/src-tauri/src/skills.rs apps/desktop/src-tauri/src/runtime/codex apps/desktop/src-tauri/src/lib.rs
git commit -m "feat: install skills safely for Claude and Codex"
```

### Task 4: Replace the Claude-only skill UI with target-aware state

**Files:**

- Create: `apps/desktop/src/stores/skill-store.ts`
- Create: `apps/desktop/src/components/skills/skill-target-picker.tsx`
- Create: `apps/desktop/src/components/skills/skill-library.tsx`
- Create: `apps/desktop/src/__tests__/stores/skill-store.test.ts`
- Modify: `apps/desktop/src/components/scientific-skills/scientific-skills-onboarding.tsx:38-170,204-302,410-648`

- [ ] **Step 1: Write store tests before UI changes**

Mock the new Tauri commands and assert: importing to both produces two targets under one catalog item; project target requires project path; unmanaged skills are visible but bulk-delete-disabled; a Codex discovery error remains visible; deleting one managed target leaves the other target installed.

- [ ] **Step 2: Run the store tests and verify failure**

Run:

```powershell
corepack pnpm --filter @claude-prism/desktop test -- skill-store
```

Expected: FAIL because `useSkillStore` is missing.

- [ ] **Step 3: Implement the skill store**

Use this state contract:

```ts
interface SkillStoreState {
  skills: RuntimeSkill[];
  loading: boolean;
  error: string | null;
  refresh(projectPath?: string): Promise<void>;
  importFolder(sourcePath: string, targets: SkillTarget[], projectPath?: string): Promise<void>;
  removeManaged(entryId: string, confirmModified: boolean): Promise<void>;
  setCodexEnabled(skill: RuntimeSkill, enabled: boolean, projectPath?: string): Promise<void>;
}
```

The store does not hardcode `~/.claude` or `~/.agents`; it displays backend-resolved paths.

- [ ] **Step 4: Implement target-aware import and catalog UI**

The picker offers Claude, Codex, or both and user/project scope. Disable project scope with an explanation when no project is open. Each installed target shows runtime, scope, managed/unmanaged, enabled state, resolved path, and discovery error. The destructive bulk action is labeled `Uninstall managed skills`.

- [ ] **Step 5: Preserve curated category behavior**

Keep current scientific skill categories and install progress. Curated install calls the new command with selected targets; imported skills appear in their current Imported Skills group. Remove text claiming every skill lives only in `~/.claude/skills`.

- [ ] **Step 6: Run store tests, full existing skill tests, and build**

```powershell
corepack pnpm --filter @claude-prism/desktop test -- skill-store
corepack pnpm --filter @claude-prism/desktop test
corepack pnpm --filter @claude-prism/desktop build
```

Expected: PASS.

- [ ] **Step 7: Commit the skill UI**

```powershell
git add apps/desktop/src/stores/skill-store.ts apps/desktop/src/components/skills apps/desktop/src/components/scientific-skills apps/desktop/src/__tests__/stores/skill-store.test.ts
git commit -m "feat: manage skills by runtime and scope"
```

### Task 5: Parse and write native Claude and Codex agent files safely

**Files:**

- Create: `apps/desktop/src-tauri/src/agents/mod.rs`
- Create: `apps/desktop/src-tauri/src/agents/claude.rs`
- Create: `apps/desktop/src-tauri/src/agents/codex.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs:1-10`
- Modify: `apps/desktop/src/runtime/types.ts`

- [ ] **Step 1: Write filename and scope tests**

Accept lower-case letters, digits, `_`, and `-`; normalize spaces to `-`; reject empty, `.`/`..`, separators, device names on Windows, and paths outside the selected agents root.

- [ ] **Step 2: Write Claude round-trip tests**

Start from Markdown containing known frontmatter, an unknown `color` field, and instructions. Change model and skills, write, read again, and assert `color` and instructions remain. Assert the `skills` list contains native skill names, not UI IDs.

- [ ] **Step 3: Write Codex round-trip tests**

Start from TOML containing `name`, `description`, `developer_instructions`, `model`, `model_reasoning_effort`, `sandbox_mode`, `nickname_candidates`, `skills.config`, and an unknown table. Change reasoning and skills, then assert comments/unknown table remain through `toml_edit`.

- [ ] **Step 4: Run parser tests and verify failure**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml agents --lib
```

Expected: FAIL because agent modules are missing.

- [ ] **Step 5: Implement the common profile**

Use:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub id: String,
    pub runtime: RuntimeKind,
    pub scope: SkillScope,
    pub name: String,
    pub description: String,
    pub instructions: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub sandbox_mode: Option<String>,
    pub permission_mode: Option<String>,
    pub tools: Vec<String>,
    pub nickname_candidates: Vec<String>,
    pub skill_ids: Vec<String>,
    pub source_path: String,
}
```

Add the matching TypeScript `AgentProfile` to `src/runtime/types.ts`, including every Claude- and Codex-specific optional field shown above; do not create a second incompatible frontend profile type.

Claude roots are `~/.claude/agents` and `<project>/.claude/agents`; Codex roots are `~/.codex/agents` and `<project>/.codex/agents`.

- [ ] **Step 6: Implement native writers**

Claude writes YAML keys `name`, `description`, `model`, `effort`, `permissionMode`, `tools`, and `skills`, followed by the instruction body. Codex writes `name`, `description`, `developer_instructions`, optional `nickname_candidates`, `model`, `model_reasoning_effort`, `sandbox_mode`, and one `[[skills.config]]` table per assigned absolute `SKILL.md` path with `enabled = true`.

- [ ] **Step 7: Implement atomic replacement and backups**

Write a sibling temporary file and rename. When an unmanaged same-name file exists and overwrite is confirmed, create `<filename>.<UTC timestamp>.bak` first. Editing a managed or explicitly selected existing profile preserves unknown fields. Deleting an agent removes only its definition file and never follows or deletes skill paths.

- [ ] **Step 8: Run tests and commit parsers**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml agents --lib
git add apps/desktop/src-tauri/src/agents apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock
git commit -m "feat: parse native Claude and Codex agents"
```

### Task 6: Add validated agent CRUD commands and skill assignment

**Files:**

- Modify: `apps/desktop/src-tauri/src/agents/mod.rs`
- Modify: `apps/desktop/src-tauri/src/agents/claude.rs`
- Modify: `apps/desktop/src-tauri/src/agents/codex.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs:590-649`

- [ ] **Step 1: Write CRUD integration tests with temporary home/project roots**

Cover list precedence (project wins display collision but both source paths remain identifiable), create, update, overwrite refusal, overwrite with backup, delete, missing skill assignment, wrong-runtime skill assignment, and Codex absolute skill path generation.

- [ ] **Step 2: Run integration tests and verify failure**

Run:

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml agent_crud --lib
```

Expected: FAIL because commands are not registered.

- [ ] **Step 3: Implement command contracts**

```rust
#[tauri::command]
pub async fn agent_list(runtime: RuntimeKind, project_path: Option<String>) -> Result<Vec<AgentProfile>, String>;

#[tauri::command]
pub async fn agent_save(
    app: tauri::AppHandle,
    profile: AgentProfile,
    project_path: Option<String>,
    overwrite: bool,
) -> Result<AgentProfile, String>;

#[tauri::command]
pub async fn agent_delete(
    runtime: RuntimeKind,
    scope: SkillScope,
    agent_id: String,
    project_path: Option<String>,
) -> Result<(), String>;
```

Before save, resolve every `skill_id` through the skill catalog, require a destination for the same runtime/scope, and reject missing or discovery-error targets. Assignment means preload/enable; it is not an exclusive allow-list.

- [ ] **Step 4: Register commands and run all Rust tests**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml agents --lib
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml skills --lib
```

Expected: PASS.

- [ ] **Step 5: Commit CRUD**

```powershell
git add apps/desktop/src-tauri/src/agents apps/desktop/src-tauri/src/lib.rs
git commit -m "feat: add custom agent CRUD and skill assignment"
```

### Task 7: Add agent library/editor state and composer selection

**Files:**

- Create: `apps/desktop/src/stores/agent-store.ts`
- Create: `apps/desktop/src/components/agents/agent-library.tsx`
- Create: `apps/desktop/src/components/agents/agent-editor.tsx`
- Create: `apps/desktop/src/components/agents/agent-selector.tsx`
- Create: `apps/desktop/src/components/settings/settings-dialog.tsx`
- Create: `apps/desktop/src/__tests__/stores/agent-store.test.ts`
- Modify: `apps/desktop/src/components/claude-chat/chat-composer.tsx`
- Modify: `apps/desktop/src/stores/claude-chat-store.ts`
- Modify: `apps/desktop/src/components/workspace/sidebar.tsx`

- [ ] **Step 1: Write agent-store tests**

Assert runtime filtering, project/user precedence, validation messages, overwrite confirmation propagation, assigned skills restricted to compatible targets, deleting an agent leaving the skill store unchanged, and selecting an agent applying model/reasoning defaults without preventing a per-tab override.

- [ ] **Step 2: Run the tests and verify failure**

Run:

```powershell
corepack pnpm --filter @claude-prism/desktop test -- agent-store
```

Expected: FAIL because the store is absent.

- [ ] **Step 3: Implement the store**

```ts
interface AgentStoreState {
  agents: AgentProfile[];
  loading: boolean;
  error: string | null;
  refresh(runtime: RuntimeKind, projectPath?: string): Promise<void>;
  save(profile: AgentProfile, projectPath: string | undefined, overwrite: boolean): Promise<AgentProfile>;
  remove(profile: AgentProfile, projectPath?: string): Promise<void>;
  compatible(runtime: RuntimeKind): AgentProfile[];
}
```

- [ ] **Step 4: Implement library and editor**

Fields change by runtime but share name, description, instructions, scope, model, and assigned skills. Claude exposes effort, permission mode, and tools; Codex exposes reasoning effort, sandbox mode, and nickname candidates. Show the native source path and collision scope before overwrite. Never render or edit a credential.

- [ ] **Step 5: Implement composer selection**

Offer `Default` plus agents whose `runtime` equals the tab runtime. Selecting an agent sets `agentId` and fills model/reasoning only when the tab has no explicit override. Clearing restores runtime defaults. For Claude, the adapter passes the saved native agent slug through `--agent`. Codex app-server has no root `agentId` field, so the Codex adapter deliberately projects the selected profile's supported model, effort, sandbox, and `developer_instructions` fields into `thread/start`/`turn/start`; the standalone TOML remains the native definition used when Codex spawns that role as a child. Add tests for both paths.

- [ ] **Step 6: Add the shared Settings entry point**

Create a dialog with exactly three tabs: AI Runtimes mounts the runtime settings from plan 1; Skills mounts `SkillLibrary`; Agents mounts `AgentLibrary`. Add one footer gear action in `workspace/sidebar.tsx`. Remove direct Claude-only wording from the old Skills entry while retaining its open-state compatibility until callers migrate.

- [ ] **Step 7: Run tests and build**

```powershell
corepack pnpm --filter @claude-prism/desktop test -- agent-store dual-runtime-chat
corepack pnpm --filter @claude-prism/desktop build
```

Expected: PASS.

- [ ] **Step 8: Commit agent UI**

```powershell
git add apps/desktop/src/stores/agent-store.ts apps/desktop/src/components/agents apps/desktop/src/components/settings apps/desktop/src/components/workspace/sidebar.tsx apps/desktop/src/components/claude-chat/chat-composer.tsx apps/desktop/src/stores/claude-chat-store.ts apps/desktop/src/__tests__/stores/agent-store.test.ts
git commit -m "feat: configure custom agents with skills"
```

### Task 8: Add non-destructive Codex project onboarding and close the phase

**Files:**

- Modify: `apps/desktop/src/components/project-wizard.tsx`
- Modify: `apps/desktop/src/stores/project-store.ts`
- Modify: `apps/desktop/src/__tests__/stores/project-store.test.ts`

- [ ] **Step 1: Write project creation tests**

Cover Claude-only, Codex-only, both, an existing `AGENTS.md`, an existing `CLAUDE.md`, and enabling Codex later. Assert no existing file is overwritten and no agent/skill directory is recursively changed.

- [ ] **Step 2: Run the project tests and verify failure**

Run:

```powershell
corepack pnpm --filter @claude-prism/desktop test -- project-store
```

Expected: FAIL on Codex project support assertions.

- [ ] **Step 3: Implement the explicit wizard option**

When Codex is selected as initial runtime or explicitly enabled, create `AGENTS.md` only if it does not exist. Its initial content is:

```markdown
# Project Instructions

Work inside this project directory. Preserve existing LaTeX structure and verify generated outputs before reporting completion.
```

Do not create or overwrite `CLAUDE.md`, agent files, or skill files as a side effect.

- [ ] **Step 4: Run the complete phase gate**

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
corepack pnpm --filter @claude-prism/desktop test
corepack pnpm exec biome check
corepack pnpm --filter @claude-prism/desktop build
```

Expected: all commands exit `0`.

- [ ] **Step 5: Perform native-format smoke checks**

Import one standard skill to both user scopes, refresh Codex `skills/list`, save one Claude agent and one Codex agent assigned to that skill, inspect the resulting Markdown/TOML, restart the app, and verify both profiles and assignments reload. Edit an unmanaged file containing unknown fields and verify those fields survive.

- [ ] **Step 6: Commit the completed phase**

```powershell
git add apps/desktop/src apps/desktop/src-tauri/src apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock
git commit -m "feat: complete runtime skills and custom agents"
```

## Phase exit evidence

- A standard skill can target Claude, Codex, or both at user/project scope.
- Codex visibility is proven by `skills/list`, not only filesystem presence.
- Bulk uninstall removes only manifest-owned unmodified copies; unmanaged skills survive.
- Claude Markdown and Codex TOML agent files preserve unknown fields and use native assigned-skill configuration.
- Agent deletion never deletes skills, and the composer shows only agents compatible with its tab runtime.
