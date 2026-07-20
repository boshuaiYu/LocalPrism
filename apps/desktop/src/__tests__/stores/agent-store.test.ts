import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { emptyAgentProfile, useAgentStore } from "@/stores/agent-store";
import type { AgentProfile } from "@/runtime/types";

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
});
