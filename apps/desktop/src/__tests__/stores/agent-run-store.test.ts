import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { buildAgentRunTree, useAgentRunStore } from "@/stores/agent-run-store";
import type { AgentRun, ConversationRef } from "@/runtime/types";

const root: ConversationRef = {
  runtime: "codex",
  sessionId: "root",
  projectPath: "/tmp/paper",
};

function run(
  id: string,
  status: AgentRun["status"],
  parentId: string | null = "root",
  overrides: Partial<AgentRun> = {},
): AgentRun {
  return {
    id,
    parentId,
    rootConversationId: "root",
    runtime: "codex",
    agentName: id,
    agentRole: null,
    model: "gpt-5.4",
    status,
    startedAt: 100,
    completedAt:
      status === "completed" || status === "failed" || status === "cancelled"
        ? 200
        : null,
    activity: status,
    summary: null,
    error: null,
    transcriptAvailable: true,
    ...overrides,
  };
}

describe("agent-run-store", () => {
  beforeEach(() => {
    useAgentRunStore.getState().reset();
    vi.mocked(invoke).mockReset();
  });

  it("accepts child before parent and fills parent later", () => {
    const store = useAgentRunStore.getState();
    store.applyEvent(root, {
      type: "subagentDiscovered",
      run: run("child", "running", null),
    });
    expect(
      useAgentRunStore.getState().runsByRoot["codex:root"]?.child?.parentId,
    ).toBeNull();

    store.applyEvent(root, {
      type: "subagentStatusChanged",
      run: run("child", "running", "root"),
    });
    expect(
      useAgentRunStore.getState().runsByRoot["codex:root"]?.child?.parentId,
    ).toBe("root");
  });

  it("keeps terminal status monotonic across regressions", () => {
    const store = useAgentRunStore.getState();
    store.applyEvent(root, {
      type: "subagentDiscovered",
      run: run("child", "running"),
    });
    store.applyEvent(root, {
      type: "subagentStatusChanged",
      run: run("child", "completed"),
    });
    store.applyEvent(root, {
      type: "subagentStatusChanged",
      run: run("child", "running"),
    });
    store.applyEvent(root, {
      type: "subagentStatusChanged",
      run: run("child", "queued"),
    });

    const saved = useAgentRunStore.getState().runsByRoot["codex:root"]?.child;
    expect(saved?.status).toBe("completed");
  });

  it("builds a tree with running-first ordering and nested children", () => {
    const tree = buildAgentRunTree([
      run("done", "completed"),
      run("active", "running"),
      run("nested", "queued", "active"),
    ]);
    expect(tree.map((node) => node.id)).toEqual(["active", "done"]);
    expect(tree[0]?.children.map((node) => node.id)).toEqual(["nested"]);
  });

  it("merges recovery without changing selection of another root", async () => {
    vi.mocked(invoke).mockResolvedValue([run("recovered", "completed")]);
    const store = useAgentRunStore.getState();
    store.applyEvent(
      { ...root, sessionId: "other" },
      {
        type: "subagentDiscovered",
        run: { ...run("x", "running"), rootConversationId: "other" },
      },
    );
    store.selectRun("x");
    await store.restore(root);
    expect(invoke).toHaveBeenCalledWith("runtime_agent_runs", {
      runtime: "codex",
      rootConversationId: "root",
      projectPath: "/tmp/paper",
    });
    expect(useAgentRunStore.getState().selectedRunId).toBe("x");
    expect(
      useAgentRunStore.getState().runsByRoot["codex:root"]?.recovered?.status,
    ).toBe("completed");
  });

  it("merges recovered runs with live runs without regressing terminals", async () => {
    const store = useAgentRunStore.getState();
    store.applyEvent(root, {
      type: "subagentDiscovered",
      run: run("child", "completed", "root", { summary: "live done" }),
    });
    vi.mocked(invoke).mockResolvedValue([
      run("child", "running", "root", { activity: "stale" }),
      run("sibling", "queued", "root"),
    ]);
    await store.restore(root);
    const runs = useAgentRunStore.getState().runsByRoot["codex:root"];
    expect(runs?.child?.status).toBe("completed");
    expect(runs?.child?.summary).toBe("live done");
    expect(runs?.sibling?.status).toBe("queued");
  });

  it("isolates same nickname under different roots", () => {
    const store = useAgentRunStore.getState();
    store.applyEvent(root, {
      type: "subagentDiscovered",
      run: run("child-a", "running", "root", { agentName: "reviewer" }),
    });
    store.applyEvent(
      { ...root, sessionId: "root-b" },
      {
        type: "subagentDiscovered",
        run: {
          ...run("child-b", "running", "root-b", { agentName: "reviewer" }),
          rootConversationId: "root-b",
        },
      },
    );
    expect(
      Object.keys(useAgentRunStore.getState().runsByRoot["codex:root"] ?? {}),
    ).toEqual(["child-a"]);
    expect(
      Object.keys(useAgentRunStore.getState().runsByRoot["codex:root-b"] ?? {}),
    ).toEqual(["child-b"]);
  });
});
