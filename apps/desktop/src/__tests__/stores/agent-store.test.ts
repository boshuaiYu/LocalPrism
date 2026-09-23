import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { BUILTIN_AGENT_PRESET_SEED_VERSION } from "@/lib/agent-presets";
import {
  emptyAgentProfile,
  resetBuiltinPresetSeedForTests,
  useAgentStore,
} from "@/stores/agent-store";
import { useSettingsStore } from "@/stores/settings-store";
import type { AgentProfile, RuntimeSkill } from "@/runtime/types";

function sampleAgent(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    ...emptyAgentProfile("claude", "user"),
    id: "reviewer",
    name: "Reviewer",
    description: "Reviews code",
    instructions: "Be careful",
    skillIds: ["writer"],
    sourcePath: "C:/agents/reviewer.md",
    ...overrides,
  };
}

describe("agent-store", () => {
  beforeEach(() => {
    invoke.mockReset();
    useAgentStore.setState({
      agents: [],
      loading: false,
      error: null,
    });
    useSettingsStore.setState({
      builtinAgentPresetsSeeded: false,
      builtinAgentPresetsSeedVersion: 0,
    });
    resetBuiltinPresetSeedForTests();
  });

  it("refreshes agents for a runtime", async () => {
    const agents = [
      sampleAgent(),
      sampleAgent({ id: "coder", name: "Coder", runtime: "codex" }),
    ];
    invoke.mockResolvedValueOnce(agents);

    await useAgentStore.getState().refresh("claude", "/project");

    expect(invoke).toHaveBeenCalledWith("list_agents", {
      runtime: "claude",
      projectPath: "/project",
    });
    expect(useAgentStore.getState().agents).toEqual(agents);
    expect(useAgentStore.getState().compatible("claude")).toEqual([agents[0]]);
  });

  it("saves an agent and refreshes the catalog", async () => {
    const draft = sampleAgent({ id: "", name: "Writer" });
    const saved = sampleAgent({ id: "writer", name: "Writer" });
    invoke.mockResolvedValueOnce(saved).mockResolvedValueOnce([saved]);

    const result = await useAgentStore
      .getState()
      .save(draft, "/project", false);

    expect(invoke).toHaveBeenNthCalledWith(1, "save_agent", {
      profile: draft,
      projectPath: "/project",
      overwrite: false,
    });
    expect(result).toEqual(saved);
    expect(useAgentStore.getState().agents).toEqual([saved]);
  });

  it("propagates overwrite and delete commands", async () => {
    const existing = sampleAgent();
    invoke
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([]);

    await useAgentStore.getState().save(existing, undefined, true);
    expect(invoke).toHaveBeenCalledWith("save_agent", {
      profile: existing,
      projectPath: null,
      overwrite: true,
    });

    useAgentStore.setState({ agents: [existing] });
    await useAgentStore.getState().remove(existing);
    expect(invoke).toHaveBeenCalledWith("delete_agent", {
      runtime: "claude",
      scope: "user",
      agentId: "reviewer",
      projectPath: null,
    });
    expect(useAgentStore.getState().agents).toEqual([]);
  });

  it("surfaces save validation errors without clearing prior agents", async () => {
    const existing = sampleAgent();
    useAgentStore.setState({ agents: [existing] });
    invoke.mockRejectedValueOnce(new Error("Agent slug invalid"));

    await expect(
      useAgentStore
        .getState()
        .save(sampleAgent({ name: "../x" }), undefined, false),
    ).rejects.toThrow("Agent slug invalid");

    expect(useAgentStore.getState().agents).toEqual([existing]);
    expect(useAgentStore.getState().error).toContain("Agent slug invalid");
  });

  it("propagates incompatible assigned-skill validation from the backend", async () => {
    invoke.mockRejectedValueOnce(
      new Error("Assigned skill 'writer' is not available for Codex User"),
    );

    await expect(
      useAgentStore.getState().save(
        sampleAgent({
          runtime: "codex",
          skillIds: ["writer"],
        }),
        undefined,
        false,
      ),
    ).rejects.toThrow(/not available/i);

    expect(useAgentStore.getState().error).toMatch(/not available/i);
  });

  it("keeps the skill catalog untouched when deleting an agent", async () => {
    const existing = sampleAgent();
    useAgentStore.setState({ agents: [existing] });
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce([]);

    await useAgentStore.getState().remove(existing);

    expect(invoke).toHaveBeenCalledWith("delete_agent", {
      runtime: "claude",
      scope: "user",
      agentId: "reviewer",
      projectPath: null,
    });
    // Agent deletion must never invoke skill_delete_managed / skill_import.
    expect(
      invoke.mock.calls.some(([command]) =>
        String(command).startsWith("skill_"),
      ),
    ).toBe(false);
  });

  it("seeds missing presets and upgrades builtin copy once without touching custom agents", async () => {
    const edited = sampleAgent({
      id: "academic-polish",
      name: "润色",
      description: "old",
      instructions: "Custom instructions stay",
      skillIds: ["writer", "my-toggle"],
      model: "opus",
    });
    const custom = sampleAgent({
      id: "reviewer",
      name: "Reviewer",
      skillIds: ["keep-me"],
    });
    const saved: AgentProfile[] = [];
    invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "skill_list") {
        return Promise.resolve([
          presetSkill("academic-polish", "Academic Polish"),
          presetSkill("humanizer-academic", "Humanizer"),
          presetSkill("zotero-cite", "Zotero Cite"),
          presetSkill("citation-check", "Citation Check"),
        ]);
      }
      if (command === "list_agents") {
        return Promise.resolve([edited, custom, ...saved]);
      }
      if (command === "save_agent") {
        const payload = args as {
          profile: AgentProfile;
          overwrite: boolean;
          projectPath: string | null;
        };
        expect(payload.projectPath).toBeNull();
        expect(payload.profile.id).not.toBe("reviewer");
        if (payload.profile.id === "academic-polish") {
          expect(payload.overwrite).toBe(true);
          expect(payload.profile.skillIds).toEqual(["academic-polish"]);
          expect(payload.profile.model).toBe("opus");
          expect(payload.profile.name).toBe("论文抛光机");
        } else {
          expect(payload.overwrite).toBe(false);
        }
        const stored = {
          ...payload.profile,
          sourcePath: `/agents/${payload.profile.id}.md`,
        };
        saved.push(stored);
        return Promise.resolve(stored);
      }
      return Promise.resolve([]);
    });

    await useAgentStore.getState().ensureBuiltinPresets();

    expect(saved.map((agent) => agent.id)).toEqual([
      "de-ai",
      "peer-review",
      "academic-polish",
    ]);
    expect(saved.find((agent) => agent.id === "de-ai")?.skillIds).toEqual([
      "humanizer-academic",
    ]);
    expect(saved.find((agent) => agent.id === "peer-review")?.skillIds).toEqual(
      [],
    );
    expect(
      saved
        .filter((agent) => agent.id !== "academic-polish")
        .flatMap((agent) => agent.skillIds)
        .join(" "),
    ).not.toMatch(/zotero|citation/);
    expect(useSettingsStore.getState().builtinAgentPresetsSeedVersion).toBe(
      BUILTIN_AGENT_PRESET_SEED_VERSION,
    );
    expect(BUILTIN_AGENT_PRESET_SEED_VERSION).toBe(4);
    expect(useSettingsStore.getState().builtinAgentPresetsSeeded).toBe(true);

    invoke.mockClear();
    await useAgentStore.getState().ensureBuiltinPresets();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("treats an existing preset file as success without forcing overwrite", async () => {
    const saved: AgentProfile[] = [];
    invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === "skill_list") return Promise.resolve([]);
      if (command === "list_agents") return Promise.resolve(saved);
      if (command === "save_agent") {
        const payload = args as {
          profile: AgentProfile;
          overwrite: boolean;
        };
        expect(payload.overwrite).toBe(false);
        if (payload.profile.id === "academic-polish") {
          return Promise.reject(
            new Error(
              "Agent 'academic-polish' already exists at /agents/academic-polish.md. Pass overwrite=true to replace it.",
            ),
          );
        }
        const stored = {
          ...payload.profile,
          sourcePath: `/agents/${payload.profile.id}.md`,
        };
        saved.push(stored);
        return Promise.resolve(stored);
      }
      return Promise.resolve([]);
    });

    await useAgentStore.getState().ensureBuiltinPresets();

    expect(useSettingsStore.getState().builtinAgentPresetsSeeded).toBe(true);
    expect(useAgentStore.getState().error).toBeNull();
    expect(saved.map((agent) => agent.id)).toEqual(["de-ai", "peer-review"]);
  });

  it("does not mark presets seeded when saving fails", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "skill_list" || command === "list_agents") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error("disk full"));
    });

    await useAgentStore.getState().ensureBuiltinPresets();

    expect(useSettingsStore.getState().builtinAgentPresetsSeeded).toBe(false);
    expect(useSettingsStore.getState().builtinAgentPresetsSeedVersion).toBe(0);
    expect(useAgentStore.getState().error).toContain("disk full");
  });
});

function presetSkill(folder: string, name: string): RuntimeSkill {
  return {
    id: `claude:user:${folder}`,
    name,
    description: name,
    folder,
    sourcePath: `/skills/user/${folder}`,
    targets: [{ runtime: "claude", scope: "user" }],
    managed: true,
    compatibleRuntimes: ["claude"],
    enabled: true,
    discoveryError: null,
  };
}
